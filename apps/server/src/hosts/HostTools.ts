import { Context, Effect, FiberMap, Layer, Ref, Stream } from "effect"
import type { Rpc } from "effect/rpc"
import type { LinkId, RemoteToolCall, SessionShape, ToolOutcome, UpCall } from "@huntaway/contracts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Identity } from "../platform/Identity.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { About } from "../settings/About.ts"
import { helloOf, LinkConnections } from "./LinkConnections.ts"
import type { Live, Via } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"

// Board tool calls from other hosts' agents, run here (docs/plan/08-hosts.md, Board tools across hosts; inventory 03
// §2.3, 05 §9; the old `handle_remote`, `hub.run_up_call`): `tools.call` and the calls a host this hub dialled passes up
// on `link.upcalls`.
//
// - Down (`up: false`): from a hub, on its own connection (a session it sealed with this host's token). Run here only.
// - Up: from a linked host's agent, for the hub's board. Whoever controls that host can name any profile, so the name
//   alone proves nothing: a call is taken only if the user lets that host's agents use this board (the link's `uplink`
//   switch, off by default), only if it came the way that host is linked (a host that dials in is known only by the id
//   it claims behind the hub token every such host shares, so a dial-in under a dialled host's id isn't that host),
//   and only for a profile here whose assistant runs on that host. Refused otherwise as `Off`, with the reason. A host
//   that dialled in calls `tools.call` on the connection it attached on; a host this hub dialled offers its calls on
//   `link.upcalls`, which the hub holds open on its connection to it and answers by `link.upcallResult`.

/** The calls passed up from `host`: taken, or why not. */
export interface HostToolsShape {
  /** `tools.call` from `session` on RPC connection `over`. */
  readonly call: (payload: RemoteToolCall & { readonly up: boolean }, session: SessionShape, over: Rpc.ServerClient) => Effect.Effect<ToolOutcome>
  /** A call up from linked host `host` that came `via` that way: run as the rules allow (`Off` with why when not). */
  readonly takeUp: (host: LinkId, via: Via, call: RemoteToolCall & { readonly call_id: string }) => Effect.Effect<ToolOutcome>
}

const off = (why: string | null): ToolOutcome => ({ _tag: "Off", why })

export class HostTools extends Context.Service<HostTools, HostToolsShape>()("huntaway-server/hosts/HostTools") {
  static readonly layer = Layer.effect(
    HostTools,
    Effect.gen(function* () {
      const toolCalls = yield* ToolCalls
      const connections = yield* LinkConnections
      const repo = yield* LinkRepo
      const profiles = yield* ProfileRepo
      const { hostName } = yield* Identity

      const takeUp = Effect.fn("HostTools.takeUp")(function* (host: LinkId, via: Via, call: RemoteToolCall & { readonly call_id: string }) {
        const link = yield* repo.get(host)
        if (link === null || !link.uplink) return off(null)
        const linkedVia = via === "dial-in" ? link.mode === "inbound" : link.mode !== "inbound"
        if (!linkedVia) {
          return off(
            `${hostName} links ${link.name} ${link.mode === "inbound" ? "as a host that dials in" : "itself"}, and this call came another way, so it isn't taken`,
          )
        }
        const placed = (yield* profiles.list).some((p) => p.name === call.profile && p.assistant_host === host)
        if (!placed) {
          return off(
            `${hostName} lets ${link.name}'s agents use its board only in the profiles whose assistant runs on ${link.name}, and ${call.profile} isn't one; ` +
              `the user can pick ${link.name} as the profile's Assistant host in Settings → Profiles there`,
          )
        }
        return yield* toolCalls.upCall({ host, call_id: call.call_id, profile: call.profile, tool: call.tool, args: call.args })
      })

      const call = Effect.fn("HostTools.call")(function* (payload: RemoteToolCall & { readonly up: boolean }, session: SessionShape, over: Rpc.ServerClient) {
        const { up, ...remote } = payload
        if (!up) {
          // From a hub, on its own connection: it holds this host's token.
          if (session.via_link === null) return off("a call down a link comes from the hub on its own connection")
          return yield* toolCalls.remote(remote)
        }
        // Up, from a host that dialled in: on the connection it attached on, which says which host it is.
        const live = session.via_link === null ? yield* connections.dialInOver(over) : undefined
        if (live === undefined || live._tag === "None")
          return off(`${hostName} takes board tool calls up only from a host connected to it, on its own connection`)
        if (remote.call_id === null) return { _tag: "Err", message: "a call up a link needs its call id", not_found: false } satisfies ToolOutcome
        return yield* takeUp(live.value.id, "dial-in", { ...remote, call_id: remote.call_id })
      })

      return HostTools.of({ call, takeUp })
    }),
  )

  /**
   * The calls the hosts this hub dials pass up: for each dialled connection, `link.upcalls` held open on it, each call
   * taken (`takeUp`, `dialled`) and answered by `link.upcallResult`. A connection that comes up again is served anew.
   */
  static readonly served = Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* HostTools
      const connections = yield* LinkConnections
      const about = yield* About
      const fibers = yield* FiberMap.make<LinkId>()
      const serving = yield* Ref.make<ReadonlyMap<LinkId, Live>>(new Map())

      /** Takes `live`'s calls until its connection ends. */
      const serve = (live: Live) =>
        Effect.gen(function* () {
          const mine = helloOf(yield* about.info)
          const answer = (call: UpCall) =>
            Effect.flatMap(tools.takeUp(live.id, "dialled", call), (outcome) => live.client("link.upcallResult", { id: call.id, outcome }))
          yield* live.client("link.upcalls", mine).pipe(
            Stream.mapEffect((call) => answer(call).pipe(Effect.ignore), { concurrency: "unbounded" }),
            Stream.runDrain,
            Effect.catchCause((cause) => Effect.logDebug(`host ${live.hello.name} passes no board tool calls up`, cause)),
          )
        })

      const sync = Effect.gen(function* () {
        const now = (yield* connections.connected).filter((live) => live.via === "dialled")
        const before = yield* Ref.get(serving)
        for (const live of now) if (before.get(live.id) !== live) yield* FiberMap.run(fibers, live.id, serve(live))
        yield* Ref.set(serving, new Map(now.map((live) => [live.id, live])))
      })

      yield* connections.changes.pipe(
        Stream.runForEach(() => sync),
        Effect.forkScoped,
      )
    }),
  )
}
