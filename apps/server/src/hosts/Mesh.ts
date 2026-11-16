import { Context, Effect, FiberMap, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { Host, HostId, LinkId } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { LinkConnections, meshes, sharedWith } from "./LinkConnections.ts"
import type { Live } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"

// The mesh (HE-46; docs/plan/08-hosts.md, The mesh): every host a neighbour reaches is on this host's directory too, and
// reached through that neighbour. Each connected neighbour in the mesh has its directory watched (`hub.hosts.watch`);
// a host it lists that this one doesn't link itself is taken with the route to it, the neighbour first. A path vector:
// an entry whose route already passes through this host is left out, so no route loops back, and a host that goes away
// leaves every directory as its neighbours' do, with no counting up. Of two routes to one host the shorter is taken.

/** Hosts further than this are left out: a mesh of a few machines never needs them. */
export const MAX_HOPS = 8

/** Two directories alike, host by host. */
export const sameHosts = Schema.toEquivalence(Schema.Array(Host))

/** How long a neighbour's directory waits before it is watched again after its stream ended. */
const REWATCH = "1 second"

/**
 * The hosts the neighbours' directories reach that this host (`me`) doesn't link itself (`linked`), each with its route
 * (the neighbour first), shortest first: connected ones only, and none whose route comes back through this host.
 */
export const meshEntries = (
  me: string,
  linked: ReadonlySet<string>,
  lists: ReadonlyArray<readonly [LinkId, ReadonlyArray<Host>]>,
  names: ReadonlyMap<string, string> = new Map(),
): Array<Host> => {
  const best = new Map<string, Host>()
  for (const [via, hosts] of lists) {
    for (const h of hosts) {
      if (h.local || !h.connected || h.id === me || linked.has(h.id) || String(h.id) === String(via)) continue
      const route = [HostId.make(via), ...(h.route ?? [])]
      if (route.includes(HostId.make(me)) || route.includes(h.id) || route.length > MAX_HOPS) continue
      const had = best.get(h.id)
      if (had !== undefined && (had.route?.length ?? 0) <= route.length) continue
      best.set(h.id, {
        id: h.id,
        name: h.name,
        local: false,
        connected: true,
        mode: "mesh",
        agents: h.agents,
        url: h.url,
        version: h.version,
        protocol: h.protocol,
        capabilities: h.capabilities,
        commit: h.commit,
        updates_from: h.updates_from,
        last_seen: null,
        last_message_at: h.last_message_at,
        uplink: false,
        through: HostId.make(via),
        route,
        status: "connected",
        status_reason: names.has(via) ? `through ${names.get(via)}` : null,
        ...(h.role === undefined ? {} : { role: h.role }),
      })
    }
  }
  return [...best.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export class Mesh extends Context.Service<
  Mesh,
  {
    /** The hosts reached through a neighbour, as the directory shows them. */
    readonly entries: Effect.Effect<ReadonlyArray<Host>>
    /** The neighbours' directories changed. */
    readonly changes: Stream.Stream<void>
    /** The neighbour `host` is reached through, if the mesh reaches it. */
    readonly through: (host: HostId) => Effect.Effect<LinkId | null>
  }
>()("huntaway-server/hosts/Mesh") {
  static readonly layer = Layer.effect(
    Mesh,
    Effect.gen(function* () {
      const connections = yield* LinkConnections
      const repo = yield* LinkRepo
      const identity = yield* Identity
      const lists = yield* SubscriptionRef.make<ReadonlyMap<LinkId, ReadonlyArray<Host>>>(new Map())
      const fibers = yield* FiberMap.make<LinkId>()
      const watching = yield* Ref.make<ReadonlyMap<LinkId, Live>>(new Map())

      const forget = (id: LinkId) =>
        SubscriptionRef.update(lists, (all) => {
          if (!all.has(id)) return all
          const next = new Map(all)
          next.delete(id)
          return next
        })

      /** `live`'s directory, kept until its connection goes; watched again a second after its stream ends. */
      const watch = (live: Live) =>
        live.client("hub.hosts.watch", undefined).pipe(
          // A list like the one held changes nothing: the neighbour sends its list again whenever this host's changes,
          // so a list taken as new every time would have the two send theirs back and forth for ever.
          Stream.runForEach((hosts) =>
            SubscriptionRef.update(lists, (all) => {
              const had = all.get(live.id)
              return had !== undefined && sameHosts(had, hosts) ? all : new Map(all).set(live.id, hosts)
            }),
          ),
          Effect.catchCause((cause) => Effect.logDebug(`mesh: ${live.hello.name}'s directory`, cause)),
          Effect.andThen(forget(live.id)),
          Effect.andThen(Effect.sleep(REWATCH)),
          Effect.forever,
          Effect.ensuring(forget(live.id)),
        )

      const sync = Effect.gen(function* () {
        // A host that dialled in has its directory taken only while its link's Mesh switch is on.
        const rows = new Map((yield* repo.list).map((row) => [row.id, row]))
        const now = (yield* connections.connected).filter((live) => meshes(live.hello) && sharedWith(live, rows.get(live.id)))
        const before = yield* Ref.get(watching)
        for (const live of now) if (before.get(live.id) !== live) yield* FiberMap.run(fibers, live.id, watch(live))
        for (const id of before.keys()) {
          if (!now.some((live) => live.id === id)) {
            yield* FiberMap.remove(fibers, id)
            yield* forget(id)
          }
        }
        yield* Ref.set(watching, new Map(now.map((live) => [live.id, live])))
      })
      yield* connections.changes.pipe(
        Stream.runForEach(() => sync),
        Effect.forkScoped,
      )
      yield* sync

      const entries = Effect.gen(function* () {
        const rows = yield* repo.list
        const all = yield* SubscriptionRef.get(lists)
        return meshEntries(identity.hostId, new Set(rows.map((r) => String(r.id))), [...all], new Map(rows.map((r) => [String(r.id), r.name])))
      })

      return Mesh.of({
        entries,
        changes: SubscriptionRef.changes(lists).pipe(Stream.as(undefined)),
        through: (host) =>
          Effect.map(entries, (all) => {
            const found = all.find((h) => h.id === host)
            return found?.through === undefined || found.through === null ? null : LinkId.make(found.through)
          }),
      })
    }),
  )
}
