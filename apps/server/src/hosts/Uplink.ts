import { Context, Deferred, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import { LinkRefused, PROTOCOL } from "@huntaway/contracts"
import type { LinkHello, RemoteToolCall, SessionShape, ToolOutcome, UpCall, UpCallResult } from "@huntaway/contracts"
import { OtherHosts } from "../mcp/OtherHosts.ts"
import type { OtherHost } from "../mcp/OtherHosts.ts"
import { Identity } from "../platform/Identity.ts"
import { Hubs } from "./Hubs.ts"
import { LinkConnections } from "./LinkConnections.ts"
import type { PeerClient } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"

// Board tools across hosts, from this host's side (docs/plan/08-hosts.md, Board tools across hosts; inventory 03 §2.3,
// 05 §9; the old hosts/uplink.ts and hub.ts `call_tool`): the other hosts its agents' calls can go to (`OtherHosts`,
// which `ToolCalls` asks).
//
// - Down: each linked host connected now, by `tools.call` on its RPC client.
// - Up: the hubs that take this host's agents' calls. A hub this host dialled in to (`--hub`) is asked with
//   `tools.call` (`up: true`) on the control connection. A hub that dialled this host has no client here: it holds
//   `link.upcalls` open on its own connection (`Uplink.offer`), the calls go to it on that stream, and its answers come
//   back by `link.upcallResult` (`Uplink.answer`). A hub this host links itself is asked down instead, with its token.
//
// A call up may have run on the hub whatever becomes of its answer: a lost link or no answer in 300 s is told as "may
// or may not have taken effect".

/** How long a call to another host may take: a hub's own tools answer at once, but it may ask its other hosts. */
export const CALL_TIMEOUT = "300 seconds"

/** What the agent is told when a call went up and its answer didn't come back. */
const maybe = (what: string, tool: string) =>
  `${what}: this ${tool} call may or may not have taken effect there. Check (with get_task or list_tasks, say) before you call it again.`

const err = (message: string): ToolOutcome => ({ _tag: "Err", message, not_found: false })

/** `tools.call` on a host's client, its failures told as the agent is told them. */
const viaClient =
  (client: PeerClient, name: string, up: boolean) =>
  (call: RemoteToolCall): Effect.Effect<ToolOutcome> =>
    client("tools.call", { profile: call.profile, tool: call.tool, args: call.args, call_id: call.call_id, up }).pipe(
      Effect.timeoutOption(CALL_TIMEOUT),
      Effect.map(Option.getOrElse(() => err(up ? maybe(`${name} didn't answer in time`, call.tool) : `${name} didn't answer in time`))),
      Effect.catch((e) =>
        Effect.succeed(
          err(
            up
              ? maybe(`lost the link to ${name} before it answered`, call.tool)
              : `couldn't reach ${name} (${e._tag}), so this ${call.tool} call wasn't run there`,
          ),
        ),
      ),
    )

/** A hub that dialled this host, holding `link.upcalls` open: the calls offered to it, and those waiting for answers. */
interface Holder {
  readonly hello: LinkHello
  readonly calls: Queue.Queue<UpCall>
  readonly pending: Ref.Ref<ReadonlyMap<number, Deferred.Deferred<ToolOutcome | null>>>
}

/** `all` without `key`. */
const without = <K, V>(all: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(all)
  next.delete(key)
  return next
}

export interface UplinkShape {
  /**
   * A hub that dialled this host, saying `hello`, on its own connection (`session`: a sealed session of kind `link`
   * from that hub): the calls this host's agents pass up to it, until it goes. It takes the place of an earlier
   * connection of the same hub, whose waiting calls are then told the link was lost.
   */
  readonly offer: (hello: LinkHello, session: SessionShape) => Stream.Stream<UpCall, LinkRefused>
  /** The answer of the hub on `session`'s connection to one of the calls it was offered. */
  readonly answer: (session: SessionShape, result: UpCallResult) => Effect.Effect<void>
  /** The hubs holding `link.upcalls` open now, as hosts a call can go to. */
  readonly holders: Effect.Effect<ReadonlyArray<OtherHost>>
}

export class Uplink extends Context.Service<Uplink, UplinkShape>()("huntaway-server/hosts/Uplink") {
  static readonly layer = Layer.effect(
    Uplink,
    Effect.gen(function* () {
      const identity = yield* Identity
      const holders = yield* Ref.make<ReadonlyMap<string, Holder>>(new Map())
      const counter = yield* Ref.make(0)

      /** Calls `holder`'s hub: offered on its stream, answered by `answer`. */
      const callOn = (holder: Holder) =>
        Effect.fnUntraced(function* (call: RemoteToolCall) {
          const name = holder.hello.name
          const id = yield* Ref.updateAndGet(counter, (n) => n + 1)
          const answered = yield* Deferred.make<ToolOutcome | null>()
          yield* Ref.update(holder.pending, (all) => new Map(all).set(id, answered))
          return yield* Effect.gen(function* () {
            const offered = yield* Queue.offer(holder.calls, { id, profile: call.profile, tool: call.tool, args: call.args, call_id: call.call_id ?? `${id}` })
            if (!offered) return err(`lost the link to ${name}, so this ${call.tool} call wasn't sent there`)
            const answer = yield* Deferred.await(answered).pipe(Effect.timeoutOption(CALL_TIMEOUT))
            if (Option.isNone(answer)) return err(maybe(`${name} didn't answer in time`, call.tool))
            return answer.value ?? err(maybe(`lost the link to ${name} before it answered`, call.tool))
          }).pipe(Effect.ensuring(Ref.update(holder.pending, (all) => without(all, id))))
        })

      /** `holder` went: its calls waiting for answers are told the link was lost. */
      const drop = (holder: Holder) =>
        Effect.gen(function* () {
          yield* Ref.update(holders, (all) => (all.get(holder.hello.host_id) === holder ? without(all, holder.hello.host_id) : all))
          yield* Queue.shutdown(holder.calls)
          const waiting = yield* Ref.getAndSet(holder.pending, new Map())
          yield* Effect.forEach(waiting.values(), (d) => Deferred.succeed(d, null), { concurrency: 1, discard: true })
        })

      const offer = (hello: LinkHello, session: SessionShape): Stream.Stream<UpCall, LinkRefused> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Only the hub itself: its own connection carries a session it sealed with this host's token, naming it.
            if (session.kind !== "link" || session.via_link === null || String(session.via_link) !== String(hello.host_id)) {
              return yield* new LinkRefused({ reason: "board tool calls go up only to a hub on its own connection" })
            }
            if (hello.host_id === identity.hostId) return yield* new LinkRefused({ reason: "that's this host" })
            const holder: Holder = {
              hello,
              calls: yield* Queue.unbounded<UpCall>(),
              pending: yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<ToolOutcome | null>>>(new Map()),
            }
            const before = yield* Ref.modify(holders, (all): [Holder | undefined, ReadonlyMap<string, Holder>] => [
              all.get(hello.host_id),
              new Map(all).set(hello.host_id, holder),
            ])
            if (before !== undefined) yield* drop(before)
            yield* Effect.addFinalizer(() => drop(holder))
            yield* Effect.logInfo(`hub ${hello.name} takes this host's board tool calls`)
            return Stream.fromQueue(holder.calls)
          }),
        )

      const answer = Effect.fn("Uplink.answer")(function* (session: SessionShape, result: UpCallResult) {
        if (session.kind !== "link" || session.via_link === null) return
        const holder = (yield* Ref.get(holders)).get(session.via_link)
        if (holder === undefined) return
        const waiting = (yield* Ref.get(holder.pending)).get(result.id)
        if (waiting !== undefined) yield* Deferred.succeed(waiting, result.outcome)
      })

      return Uplink.of({
        offer,
        answer,
        holders: Effect.map(Ref.get(holders), (all) =>
          [...all.values()].map((holder): OtherHost => ({ id: holder.hello.host_id, name: holder.hello.name, call: callOn(holder) })),
        ),
      })
    }),
  )

  /**
   * The other hosts a board tool call can go to (`mcp/OtherHosts`): the links connected now (those that speak this
   * host's protocol), then the hubs this host dialled in to and those that hold `link.upcalls` open, each once, by
   * name, leaving out a hub this host links itself.
   */
  static readonly otherHosts = Layer.effect(
    OtherHosts,
    Effect.gen(function* () {
      const connections = yield* LinkConnections
      const hubs = yield* Hubs
      const uplink = yield* Uplink
      const repo = yield* LinkRepo

      const links = Effect.gen(function* () {
        const rows = new Map((yield* repo.list).map((row) => [row.id, row.name]))
        return (yield* connections.connected)
          .filter((live) => live.hello.protocol === PROTOCOL)
          .map((live): OtherHost => {
            const name = rows.get(live.id) ?? live.hello.name
            return { id: live.id, name, call: viaClient(live.client, name, false) }
          })
      })

      const upHubs = Effect.gen(function* () {
        const linked = new Set((yield* connections.connected).map((live) => String(live.id)))
        const out = new Map<string, OtherHost>()
        for (const hub of yield* hubs.connected) {
          const id = hub.hello.host_id
          if (!linked.has(id) && !out.has(id)) out.set(id, { id, name: hub.hello.name, call: viaClient(hub.client, hub.hello.name, true) })
        }
        for (const holder of yield* uplink.holders) if (!linked.has(holder.id) && !out.has(holder.id)) out.set(holder.id, holder)
        return [...out.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      })

      return OtherHosts.of({ links, hubs: upHubs })
    }),
  )
}
