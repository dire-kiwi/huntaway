import { Context, Effect, Layer, Option, Stream } from "effect"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { HostId, SettingsSyncStatus, SyncEntry, SyncLost } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { makeFields, SETTING, SINCE } from "./settingsSync/fields.ts"
import type { Field, FieldEvent } from "./settingsSync/fields.ts"
import { canon, checkEntries, mergeEntry, parseJson } from "./settingsSync/merge.ts"
import { SettingsSyncRepo } from "./SettingsSyncRepo.ts"
import type { SyncRow } from "./SettingsSyncRepo.ts"

// Settings sync, a host's side (docs/plan/08-hosts.md; inventory 05 §2.7, §9 Settings sync): the settings that mean the
// same on every host are kept the same on the hosts that switch it on, by a hub that passes them between its hosts
// (`SettingsSyncExchange`). What syncs and how two values merge are `settingsSync/fields.ts` and `settingsSync/merge.ts`.
//
// The host's own tables stay where they are. `observe` compares each field with what its entry last saw there (`seen`):
// a difference is a change made here, which bumps this host's counter, however it was made. It runs right after a
// change, on the `settings_changed`, `profiles_changed` and `approval_rules` events (`SettingsSync.observer`), and at the
// start of every read and merge, as the old server did; not inside the transactions that make the changes, so the
// services that own those tables need not know about sync, and a write that announces nothing is still caught at the
// next look. An entry for a profile this host doesn't have is kept (and passed on), and applied when a profile of that
// name appears.

/** An entry being worked on in a pass. */
type Row = { -readonly [K in keyof SyncRow]: SyncRow[K] } & { lost: Array<SyncLost> }

/** An entry as a row, with what this host's tables last had (`seen`). */
const rowOf = (e: SyncEntry, seen: string | null): Row => ({
  name: e.name,
  value: e.value,
  vv: e.vv,
  changed_at: e.changed_at,
  changed_by: e.changed_by,
  since: e.since,
  lost: [...e.lost],
  seen,
})
const entryOf = (r: SyncRow): SyncEntry => ({
  name: r.name,
  value: r.value,
  vv: r.vv,
  changed_at: r.changed_at,
  changed_by: r.changed_by,
  since: r.since,
  lost: r.lost,
})

/** What a pass over the entries did: whether any entry changed, and which fields changed here. */
interface Pass {
  changed: boolean
  readonly events: Array<FieldEvent>
}

export interface SettingsSyncShape {
  /** Whether this host syncs its settings (`settings_sync`). */
  readonly enabled: Effect.Effect<boolean>
  /** Notes the changes made on this host since the last look. Nothing while sync is off. */
  readonly observe: Effect.Effect<void>
  /** This host's entries, up to date with its tables: none while sync is off. */
  readonly entries: Effect.Effect<ReadonlyArray<SyncEntry>>
  /** `settingsSync.get`. */
  readonly status: Effect.Effect<SettingsSyncStatus>
  /** Merges another host's entries into this host's and applies those that changed: how many changed. */
  readonly merge: (incoming: ReadonlyArray<SyncEntry>) => Effect.Effect<number, Unavailable | Invalid>
  /**
   * Settles a field two hosts changed apart: `value` (one that lost, or any other) becomes its value, or with none the
   * value that won stays. Either way a change made here, which the other hosts take.
   */
  readonly resolve: (name: string, value: Option.Option<unknown>) => Effect.Effect<SettingsSyncStatus, Unavailable | Invalid>
}

/** Sets a field here to its entry's value, if it differs, and notes what its tables then have. */
const apply = (f: Field, r: Row, pass: Pass) =>
  Effect.gen(function* () {
    const before = canon(yield* f.read)
    if (before !== canon(r.value)) {
      yield* f.write(r.value).pipe(Effect.catch((e) => Effect.logWarning(`settings sync: ${r.name} stays as it is here: ${e.reason}`)))
    }
    const after = canon(yield* f.read)
    if (after !== before) pass.events.push(f.event)
    r.seen = after
  })

const off = new Unavailable({ what: "settings sync", reason: "settings sync is off on this host" })

export class SettingsSync extends Context.Service<SettingsSync, SettingsSyncShape>()("huntaway-server/hosts/SettingsSync") {
  static readonly layer = Layer.effect(
    SettingsSync,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* SettingsSyncRepo
      const settings = yield* SettingsRepo
      const identity = yield* Identity
      const { fields, announce } = yield* makeFields
      const me: HostId = identity.hostId

      const enabled = Effect.map(settings.get(SETTING), (v) => v === "true")

      /** A change made on this host: its counter goes up, and what lost to the value before is dropped. */
      const bump = (r: Row, value: unknown, now: string) => {
        r.value = value
        r.vv = { ...r.vv, [me]: (r.vv[me] ?? 0) + 1 }
        r.changed_at = now
        r.changed_by = me
        r.since = ""
        r.lost = []
      }

      /**
       * A value this host had before it synced (or set while sync was off): it has no time, so any change a syncing
       * host made wins over it, and of two such values the one from the host that began to sync first does. Its vector
       * is this host's counter alone, so it never counts as having seen what the board has.
       */
      const beforeSync = (r: Row, value: unknown, since: string) => {
        r.value = value
        r.vv = { [me]: (r.vv[me] ?? 0) + 1 }
        r.changed_at = ""
        r.changed_by = me
        r.since = since
        r.lost = []
      }

      /**
       * Brings the entries up to date with this host's own tables (inside a transaction): a field that isn't as its
       * entry last saw it was changed here; one with no entry gets its first, which loses to any host's real change (it
       * has no time); and an entry kept for a profile that has appeared since is applied to it.
       */
      const observeIn = (have: Map<string, Row>, pass: Pass) =>
        Effect.gen(function* () {
          const now = yield* nowTimestamp
          // The first look since sync was switched on: what differs was set while it was off, not just now.
          const kept = yield* settings.get(SINCE)
          const joining = kept === null
          const since = kept ?? now
          if (joining) {
            yield* settings.set(SINCE, since)
            // Entries kept from an earlier time it synced that no other host has heard of (only its own counter) are its
            // own values still, and begin again with it: they'd otherwise say it began to sync then, before hosts that
            // have been syncing since, or carry the time of a change no host was there to take.
            for (const r of have.values()) {
              const hosts = Object.keys(r.vv)
              if (hosts.length === 1 && hosts[0] === me) {
                beforeSync(r, r.value, since)
                yield* repo.put(r)
                pass.changed = true
              }
            }
          }
          const here = new Map((yield* fields).map((f) => [f.name, f]))
          for (const f of here.values()) {
            const cur = canon(yield* f.read)
            let r = have.get(f.name)
            if (r === undefined) {
              r = { name: f.name, value: null, vv: {}, changed_at: "", changed_by: me, since, lost: [], seen: cur }
              beforeSync(r, parseJson(cur), since)
              have.set(f.name, r)
            } else if (r.seen === null) {
              yield* apply(f, r, pass)
            } else if (r.seen !== cur) {
              if (joining) beforeSync(r, parseJson(cur), since)
              else bump(r, parseJson(cur), now)
              r.seen = cur
            } else if (canon(r.value) !== cur) {
              // A value this host couldn't take: try again, in case it's since been updated.
              yield* apply(f, r, pass)
              if (r.seen === cur) continue
            } else {
              continue
            }
            yield* repo.put(r)
            pass.changed = true
          }
          // A profile that's gone (or renamed): its entries are kept, for one of that name.
          for (const r of have.values()) {
            if (r.seen !== null && !here.has(r.name)) {
              r.seen = null
              yield* repo.put(r)
            }
          }
          return here
        })

      const rows = Effect.map(repo.all, (all) => new Map([...all].map(([name, r]) => [name, rowOf(r, r.seen)])))

      /** Announces what a pass changed here; entries that changed are news too (to the hub, and to the list of lost values). */
      const done = (pass: Pass) => announce(pass.changed ? [...pass.events, { _tag: "settings" }] : pass.events)

      const observe = Effect.gen(function* () {
        if (!(yield* enabled)) {
          if ((yield* settings.get(SINCE)) !== null) yield* settings.set(SINCE, null)
          return
        }
        yield* db.tx(
          Effect.gen(function* () {
            const pass: Pass = { changed: false, events: [] }
            yield* observeIn(yield* rows, pass)
            // (A change made here was announced by whoever made it: only what was applied is news.)
            pass.changed = false
            yield* done(pass)
          }),
        )
      }).pipe(Effect.withSpan("SettingsSync.observe"))

      const entries = Effect.gen(function* () {
        if (!(yield* enabled)) return []
        yield* observe
        return [...(yield* repo.all).values()].map(entryOf)
      })

      const status = Effect.gen(function* () {
        return { enabled: yield* enabled, host_id: me, entries: yield* entries }
      })

      const merge = Effect.fn("SettingsSync.merge")(function* (given: ReadonlyArray<SyncEntry>) {
        if (!(yield* enabled)) return yield* off
        const incoming = yield* checkEntries(given)
        return yield* db.tx(
          Effect.gen(function* () {
            const pass: Pass = { changed: false, events: [] }
            const have = yield* rows
            const here = yield* observeIn(have, pass)
            pass.changed = false
            let n = 0
            for (const e of incoming) {
              const local = have.get(e.name) ?? null
              const merged = mergeEntry(local, e)
              if (merged === local) continue
              const r = rowOf(merged, local?.seen ?? null)
              const f = here.get(r.name)
              if (f !== undefined) yield* apply(f, r, pass)
              yield* repo.put(r)
              have.set(r.name, r)
              n += 1
            }
            pass.changed = n > 0
            yield* done(pass)
            return n
          }),
        )
      })

      const resolve = Effect.fn("SettingsSync.resolve")(function* (name: string, value: Option.Option<unknown>) {
        if (!(yield* enabled)) return yield* off
        yield* db.tx(
          Effect.gen(function* () {
            const pass: Pass = { changed: false, events: [] }
            const have = yield* rows
            const here = yield* observeIn(have, pass)
            const r = have.get(name)
            if (r === undefined) return yield* new Invalid({ field: "name", reason: `no synced setting ${name}` })
            const f = here.get(name)
            bump(
              r,
              Option.getOrElse(value, () => r.value),
              yield* nowTimestamp,
            )
            if (f !== undefined) {
              // Checked by setting it here first: a value this host can't take isn't one to send to the others.
              const was = canon(yield* f.read)
              if (was !== canon(r.value)) yield* f.write(r.value).pipe(Effect.mapError((e) => new Invalid({ field: "value", reason: `${name} ${e.reason}` })))
              r.value = (yield* f.read) ?? null
              r.seen = canon(r.value)
              if (was !== r.seen) pass.events.push(f.event)
            }
            yield* repo.put(r)
            pass.changed = true
            return yield* done(pass)
          }),
        )
        return yield* status
      })

      return SettingsSync.of({ enabled, observe, entries, status, merge, resolve })
    }),
  )

  /**
   * Notes each change to a synced setting as it's made, so that its time is when it was made, not when a hub next
   * asked: a look at the start, then one after each event that says a synced setting may have changed.
   */
  static readonly observer = Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* SettingsSync
      const events = yield* Events
      const look = sync.observe.pipe(Effect.catchCause((cause) => Effect.logWarning("settings sync", cause)))
      // Subscribed before the first look, so nothing falls between; again (and another look) if it falls behind.
      const follow = Effect.gen(function* () {
        const watch = yield* events.watch(undefined)
        yield* look
        yield* watch.live.pipe(
          Stream.filter((e) => e.type === "settings_changed" || e.type === "profiles_changed" || e.type === "approval_rules"),
          Stream.runForEach(() => look),
        )
      }).pipe(Effect.scoped, Effect.forever)
      yield* Effect.forkScoped(follow)
    }),
  )
}
