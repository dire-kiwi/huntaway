import { Context, Duration, Effect, FiberMap, Layer, Queue, Ref, Schema, Stream } from "effect"
import type { Cause, Scope } from "effect"
import { Capability, PROTOCOL } from "@huntaway/contracts"
import type { Invalid, LinkHello, LinkId, SettingsSyncStatus, SyncEntry, Unavailable } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { LinkConnections } from "./LinkConnections.ts"
import type { Live } from "./LinkConnections.ts"
import { SettingsSync } from "./SettingsSync.ts"
import type { SettingsSyncShape } from "./SettingsSync.ts"
import { mergeEntry, parseEntries } from "./settingsSync/merge.ts"

// The hub's side of settings sync (inventory 05 §2.7, §9; the old `hosts/hub/settings_sync.ts`): hosts don't talk to
// each other, so the hub passes their entries between them. An exchange reads each connected host's entries, merges
// them into the hub's own, and sends each host what it lacks. It runs when a host connects (which is how one that was
// away catches up), and when a synced setting changes on the hub or a host. Merging twice changes nothing, so a host with
// several hubs, or an exchange that runs again for what it applied itself, settles after one more round.
//
// Only hosts with the `settings_sync` capability that have sync switched on take part, and only while the hub has it on
// too: the hub's own entries are what a host that was away catches up from.

/** How long after a change an exchange starts: one save often sends several events. */
export const DELAY = Duration.millis(200)
/** How long a linked host's event stream waits before it is opened again after it ended. */
const REWATCH = "1 second"

/** The events that say a synced setting may have changed. */
const synced = (type: string) => type === "settings_changed" || type === "profiles_changed" || type === "approval_rules"

/** A call to a host the hub exchanges entries with failed. */
export class PeerFailed extends Schema.TaggedError<PeerFailed, { readonly brand: unique symbol }>()("PeerFailed", { reason: Schema.String }) {}

/** A host the hub exchanges entries with. */
export interface SyncPeer {
  readonly id: string
  readonly name: string
  readonly get: Effect.Effect<SettingsSyncStatus, PeerFailed>
  readonly merge: (entries: ReadonlyArray<SyncEntry>) => Effect.Effect<void, PeerFailed>
}

const failed = (e: { readonly _tag: string; readonly message: string }) => new PeerFailed({ reason: e.message === "" ? e._tag : e.message })

/** Whether a host that said `hello` can take part: it speaks this protocol and has the capability. */
export const takesPart = (hello: LinkHello): boolean => hello.protocol === PROTOCOL && hello.capabilities.includes(Capability.settingsSync)

/** A connected link as a peer, if it takes part: it speaks this protocol and has the capability. */
export const peerOf = (live: Live): SyncPeer | null =>
  takesPart(live.hello)
    ? {
        id: live.id,
        name: live.hello.name,
        get: live.client("settingsSync.get", undefined).pipe(Effect.mapError(failed)),
        merge: (entries) => live.client("settingsSync.merge", { entries }).pipe(Effect.asVoid, Effect.mapError(failed)),
      }
    : null

const warn = (what: string) => (cause: Cause.Cause<unknown>) => Effect.logWarning(`settings sync: ${what}`, cause)
const warnOf = (what: string) => (error: PeerFailed | Invalid | Unavailable) => Effect.logWarning(`settings sync: ${what}: ${error.message}`)

/** One exchange between this host (`sync`) and `peers`. */
export const exchangeWith = (sync: SettingsSyncShape, peers: ReadonlyArray<SyncPeer>) =>
  Effect.gen(function* () {
    if (!(yield* sync.enabled)) return
    const theirs = new Map<SyncPeer, Map<string, SyncEntry>>()
    for (const peer of peers) {
      const read = yield* peer.get.pipe(
        Effect.flatMap((got) => (got.enabled ? parseEntries(got.entries) : Effect.succeed(null))),
        Effect.tapError(warnOf(`reading ${peer.name}'s settings`)),
        Effect.option,
      )
      if (read._tag === "None" || read.value === null) continue
      const entries = read.value
      theirs.set(peer, new Map(entries.map((e) => [e.name, e])))
      yield* sync.merge(entries).pipe(Effect.catch(warnOf(`merging ${peer.name}'s settings`)))
    }
    if (theirs.size === 0) return
    const mine = yield* sync.entries
    for (const [peer, have] of theirs) {
      const news = mine.filter((e) => {
        const h = have.get(e.name) ?? null
        return mergeEntry(h, e) !== h
      })
      if (news.length === 0) continue
      yield* peer.merge(news).pipe(Effect.catch(warnOf(`sending settings to ${peer.name}`)))
    }
  })

/**
 * `run` soon after `trigger`, once for every trigger that came before it started, never two at a time: a trigger while
 * it runs runs it again after (the old `schedule`'s timer, `running` and `again`). The loop lives as long as the scope.
 */
export const coalesced = (run: Effect.Effect<void>, delay: Duration.Input): Effect.Effect<Effect.Effect<void>, never, Scope.Scope> =>
  Effect.flatMap(Queue.dropping<void>(1), (pending) =>
    Queue.take(pending).pipe(
      Effect.andThen(Effect.sleep(delay)),
      Effect.andThen(Queue.clear(pending)),
      Effect.andThen(run),
      Effect.forever,
      Effect.forkScoped,
      Effect.as(Effect.asVoid(Queue.offer(pending, undefined))),
    ),
  )

export interface SettingsSyncExchangeShape {
  /** One exchange with every connected host that takes part, now. */
  readonly exchange: Effect.Effect<void>
  /** An exchange soon (`DELAY`), once, after the one running if one is. */
  readonly schedule: Effect.Effect<void>
}

export class SettingsSyncExchange extends Context.Service<SettingsSyncExchange, SettingsSyncExchangeShape>()("huntaway-server/hosts/SettingsSyncExchange") {
  /**
   * The exchange, run when a host connects and when a setting that syncs changes here or on a connected host: this
   * host's events, and each connected link's `board.watch` (`settings_changed`, `profiles_changed`, `approval_rules`).
   */
  static readonly layer = Layer.effect(
    SettingsSyncExchange,
    Effect.gen(function* () {
      const sync = yield* SettingsSync
      const connections = yield* LinkConnections
      const events = yield* Events

      const peers = Effect.map(connections.connected, (lives) => lives.flatMap((live) => peerOf(live) ?? []))
      const exchange = Effect.flatMap(peers, (list) => exchangeWith(sync, list)).pipe(
        Effect.catchCause(warn("exchanging")),
        Effect.withSpan("SettingsSyncExchange.exchange"),
      )
      const schedule = yield* coalesced(exchange, DELAY)

      // This host's own changes.
      yield* Effect.gen(function* () {
        const watch = yield* events.watch(undefined)
        yield* watch.live.pipe(
          Stream.filter((e) => synced(e.type)),
          Stream.runForEach(() => schedule),
        )
      }).pipe(Effect.scoped, Effect.forever, Effect.forkScoped)

      // Each connected link's changes, and an exchange when one connects (or connects again).
      const watchers = yield* FiberMap.make<LinkId>()
      const watched = yield* Ref.make<ReadonlyMap<LinkId, Live>>(new Map())
      const watchLink = (live: Live) =>
        live.client("board.watch", {}).pipe(
          Stream.filter((m) => synced(m.type)),
          Stream.runForEach(() => schedule),
          Effect.catchCause((cause) => Effect.logDebug(`settings sync: watching ${live.hello.name}`, cause)),
          Effect.andThen(Effect.sleep(REWATCH)),
          Effect.forever,
        )
      const reconcile = Effect.gen(function* () {
        const lives = (yield* connections.connected).filter((live) => peerOf(live) !== null)
        const before = yield* Ref.get(watched)
        for (const live of lives) {
          if (before.get(live.id) === live) continue
          yield* FiberMap.run(watchers, live.id, watchLink(live))
          yield* schedule
        }
        const now = new Set(lives.map((live) => live.id))
        for (const id of before.keys()) if (!now.has(id)) yield* FiberMap.remove(watchers, id)
        yield* Ref.set(watched, new Map(lives.map((live) => [live.id, live])))
      })
      yield* reconcile
      yield* connections.changes.pipe(
        Stream.runForEach(() => reconcile),
        Effect.forkScoped,
      )

      return SettingsSyncExchange.of({ exchange, schedule })
    }),
  )
}
