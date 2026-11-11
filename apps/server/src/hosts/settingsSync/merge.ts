import { Effect, Result, Schema } from "effect"
import { Invalid, SyncEntry } from "@huntaway/contracts"
import type { SyncLost } from "@huntaway/contracts"

// The merge of settings sync (inventory 05 §9, Settings sync), as plain functions: ported from the old
// `settings_sync.ts` as it was, because it is subtle and already right (docs/plan/08-hosts.md).
//
// Each synced field has an entry: its value and a version vector (a counter per host that changed it). Merging two
// entries of a field:
// - one whose vector covers the other's has seen every change the other has, and is kept: a host that was away catches
//   up, and nothing is a conflict;
// - two that neither covers were changed apart. The later change wins (by its host's clock, then by host id), the
//   vectors join, and the value that lost is kept on the entry (`lost`) for the user to pick instead. Any later change
//   to the field drops what was lost.
// A value a host had before it synced, or set while sync was off there, has no time: any change made on a syncing host
// wins over it, and of two such values the one whose host began to sync first (`since`) does. So a host that joins
// takes what the board has, and its own values are the ones kept as lost.
// Merging is idempotent, commutative and associative (for changes made apart), so hosts end up with the same entries
// whatever order they hear of them in, and from however many hubs.

export type Vv = Readonly<Record<string, number>>

/** How many lost values an entry keeps (the latest). */
export const MAX_LOST = 10
/** The most entries taken in one merge, and the longest value (as JSON). */
export const MAX_ENTRIES = 5000
export const MAX_VALUE = 256 * 1024
/** The longest entry name and host id taken. */
export const MAX_NAME = 500
export const MAX_HOST = 200

const jsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const jsonValue = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** One string, number or boolean as JSON. */
const scalar = (v: string | number | boolean): string => Result.getOrElse(jsonText(v), () => "null")

/** A value's JSON with its keys sorted, so that two hosts write the same value the same way. */
export const canon = (v: unknown): string => {
  if (v === null || v === undefined) return "null"
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return scalar(v)
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`
  if (typeof v !== "object") return "null"
  const pairs: Array<[string, unknown]> = Object.entries(v)
  const kept = pairs.filter(([, x]) => x !== undefined).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${kept.map(([k, x]) => `${scalar(k)}:${canon(x)}`).join(",")}}`
}

/** JSON text as a value; null for text that is not JSON. */
export const parseJson = (text: string): unknown => Result.getOrElse(jsonValue(text), () => null)

/** Whether vector `a` has every change `b` has. */
const covers = (a: Vv, b: Vv): boolean => Object.entries(b).every(([host, n]) => (a[host] ?? 0) >= n)

const join = (a: Vv, b: Vv): Vv => {
  const out: Record<string, number> = {}
  for (const host of [...Object.keys(a), ...Object.keys(b)].toSorted()) out[host] = Math.max(a[host] ?? 0, b[host] ?? 0)
  return out
}

/** A value with who set it and when: an entry's, or one that lost. */
type Stamp = { readonly value: unknown; readonly by: string; readonly at: string; readonly since?: string | undefined }

/**
 * Whether change `a` wins over `b` (a total order). A change with a time beats a value from before its host synced
 * (no time), and the later of two with times wins. Between two values from before sync, the one whose host began to
 * sync first wins: a host that joins takes what the board has, whatever its id. Then host id, then the value.
 */
const later = (a: Stamp, b: Stamp): boolean => {
  if (a.at !== b.at) return a.at > b.at
  // (No time for when it began, as from nothing that's written here: after any that has one.)
  const sa = a.since || "9"
  const sb = b.since || "9"
  if (a.at === "" && sa !== sb) return sa < sb
  if (a.by !== b.by) return a.by > b.by
  return canon(a.value) >= canon(b.value)
}

/** The values that lost to `winner`, one per value (its latest loss), the latest `MAX_LOST`, in a fixed order. */
const lostTo = (winner: unknown, all: ReadonlyArray<SyncLost>): Array<SyncLost> => {
  const won = canon(winner)
  const byValue = new Map<string, SyncLost>()
  for (const l of all) {
    const k = canon(l.value)
    if (k === won) continue
    const have = byValue.get(k)
    if (have === undefined || later(l, have)) byValue.set(k, l)
  }
  return [...byValue.values()].toSorted((a, b) => (later(a, b) ? -1 : 1)).slice(0, MAX_LOST)
}

const sameEntry = (a: SyncEntry, b: SyncEntry): boolean =>
  canon([a.value, a.vv, a.changed_at, a.changed_by, a.since, a.lost]) === canon([b.value, b.vv, b.changed_at, b.changed_by, b.since, b.lost])

const stamp = (e: SyncEntry): SyncLost => ({ value: e.value, by: e.changed_by, at: e.changed_at, since: e.since })

/**
 * What a host that has `local` for a field keeps once it hears of `incoming`: `local` itself (the same object) when
 * nothing changes.
 */
export const mergeEntry = (local: SyncEntry | null, incoming: SyncEntry): SyncEntry => {
  if (local === null) return incoming
  const ours = covers(local.vv, incoming.vv)
  const theirs = covers(incoming.vv, local.vv)
  if (ours && !theirs) return local
  if (theirs && !ours) return incoming
  // Changed apart (or, for vectors that are equal, the same entry: merging it changes nothing).
  const [w, l] = later(stamp(local), stamp(incoming)) ? [local, incoming] : [incoming, local]
  const merged: SyncEntry = {
    name: local.name,
    value: w.value,
    vv: join(local.vv, incoming.vv),
    changed_at: w.changed_at,
    changed_by: w.changed_by,
    since: w.since,
    lost: lostTo(w.value, [...w.lost, ...l.lost, stamp(l)]),
  }
  return sameEntry(merged, local) ? local : merged
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isTime = (t: string) => t === "" || TIME.test(t)
const isHost = (h: string) => h !== "" && h.length <= MAX_HOST

/** Why `entries` (another host's) can't be taken, or null when they can (the old `parse_entries`' limits). */
export const entriesProblem = (entries: ReadonlyArray<SyncEntry>): string | null => {
  if (entries.length > MAX_ENTRIES) return `at most ${MAX_ENTRIES} entries`
  for (const e of entries) {
    if (e.name === "" || e.name.length > MAX_NAME) return "an entry needs a name"
    const bad = (what: string) => `${e.name}: ${what}`
    if (!Object.entries(e.vv).every(([h, n]) => isHost(h) && Number.isSafeInteger(n) && n >= 1)) return bad("vv must be an object of counters by host id")
    if (!isTime(e.changed_at) || !isHost(e.changed_by)) return bad("changed_at must be a time and changed_by a host id")
    if (!isTime(e.since)) return bad("since must be a time")
    if (canon(e.value).length > MAX_VALUE) return bad("its value is too long")
    if (e.lost.length > MAX_LOST) return bad(`lost must be a list of at most ${MAX_LOST}`)
    if (!e.lost.every((l) => isTime(l.at) && isTime(l.since ?? "") && isHost(l.by) && canon(l.value).length <= MAX_VALUE)) {
      return bad("lost must be a list of {value, by, at}")
    }
  }
  return null
}

/** `entries` as taken: `since` filled in, missing values as null. */
const tidy = (e: SyncEntry): SyncEntry => ({
  name: e.name,
  value: e.value ?? null,
  vv: e.vv,
  changed_at: e.changed_at,
  changed_by: e.changed_by,
  since: e.since,
  lost: e.lost.map((l) => ({ value: l.value ?? null, by: l.by, at: l.at, since: l.since ?? "" })),
})

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(SyncEntry))

/** Entries as another host sent them, checked: `Invalid` says what is wrong with them. */
export const checkEntries = (entries: ReadonlyArray<SyncEntry>): Effect.Effect<ReadonlyArray<SyncEntry>, Invalid> => {
  const problem = entriesProblem(entries)
  return problem === null ? Effect.succeed(entries.map(tidy)) : Effect.fail(new Invalid({ field: "entries", reason: problem }))
}

/** Entries of unknown shape (a host's answer), decoded and checked. */
export const parseEntries = (input: unknown): Effect.Effect<ReadonlyArray<SyncEntry>, Invalid> =>
  decodeEntries(input).pipe(
    Effect.mapError(() => new Invalid({ field: "entries", reason: "entries must be a list of {name, value, vv, changed_at, changed_by, since, lost}" })),
    Effect.flatMap(checkEntries),
  )
