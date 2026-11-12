import { DateTime, Option, Predicate } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { UsageAccount, UsageLimit } from "@huntaway/contracts"

// The plain part of a config's usage (huntaway's agent/usage.ts): reading the usage endpoint's answer, a pool's limits
// from its accounts', merging a run's limits in, what a `rate_limit_event` says, and the times as the old board wrote
// them. `profiles/Usage` keeps the state.

/** `v[key]`, if `v` is an object that has it. */
export const field = (v: unknown, key: string): unknown => (Predicate.hasProperty(v, key) ? v[key] : undefined)

const isPlainObject = (v: unknown): boolean => Predicate.isObject(v) && !Array.isArray(v)

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

/** An RFC 3339 time, as ms since the epoch, or null if it isn't one. */
export const parseTime = (t: string): number | null => {
  if (!RFC3339.test(t)) return null
  return Option.match(DateTime.make(t.replace(" ", "T")), { onNone: () => null, onSome: DateTime.toEpochMillis })
}

/** A Unix time (seconds) as chrono's `to_rfc3339()` writes it (`+00:00`, no fraction for whole seconds). */
export const rfc3339 = (secs: number): Timestamp =>
  Timestamp.make(
    DateTime.formatIso(DateTime.makeUnsafe(secs * 1000))
      .replace(/\.000Z$/, "Z")
      .replace(/Z$/, "+00:00"),
  )

/** A Unix time (seconds), as the board writes times that are compared as text (`limit_reset_at`, `out_until`). */
export const timestamp = (secs: number): Timestamp => Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(secs * 1000)).replace(/\.\d+Z$/, "Z"))

/** How late a reset counts as come, for clocks that disagree. */
export const RESET_GRACE_MS = 60_000

/** Whether a reset noted as `limit_reset_at` has come at `now` (ms): a minute late. One that isn't a time has. */
export const isResetDue = (limitResetAt: string, now: number): boolean => {
  const t = parseTime(limitResetAt)
  return t === null || t + RESET_GRACE_MS <= now
}

/** Limits from the usage endpoint: its `limits` list, or the older per-window fields. */
export const parseLimits = (v: unknown): Array<UsageLimit> => {
  const list = field(v, "limits")
  if (Array.isArray(list)) {
    const out: Array<UsageLimit> = []
    for (const l of list) {
      const percent = field(l, "percent")
      const kind = field(l, "kind")
      if (typeof percent !== "number" || typeof kind !== "string") continue
      const name = field(field(field(l, "scope"), "model"), "display_name")
      const model = typeof name === "string" ? name : null
      let id: string
      let label: string
      if (kind === "session") [id, label] = ["session", "Session"]
      else if (kind === "weekly_all") [id, label] = ["weekly", "Weekly"]
      else if (model !== null && field(l, "group") === "weekly") [id, label] = [`weekly:${model.toLowerCase()}`, `Weekly · ${model}`]
      else [id, label] = [kind, kind.replaceAll("_", " ")]
      const resets = field(l, "resets_at")
      out.push({ id, label, percent, resets_at: typeof resets === "string" ? Timestamp.make(resets) : null })
    }
    return out
  }
  const windows: ReadonlyArray<readonly [string, string, string]> = [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly", "Weekly"],
    ["seven_day_opus", "weekly:opus", "Weekly · Opus"],
    ["seven_day_sonnet", "weekly:sonnet", "Weekly · Sonnet"],
  ]
  const out: Array<UsageLimit> = []
  for (const [key, id, label] of windows) {
    const w = field(v, key)
    const utilization = field(w, "utilization")
    if (typeof utilization !== "number") continue
    const resets = field(w, "resets_at")
    out.push({ id, label, percent: utilization, resets_at: typeof resets === "string" ? Timestamp.make(resets) : null })
  }
  return out
}

/** The order limits are shown in: the session's, then the weekly one, then the rest by id. */
const orderKey = (l: UsageLimit) => [l.id !== "session" ? 1 : 0, l.id !== "weekly" ? 1 : 0] as const
const order = (a: UsageLimit, b: UsageLimit): number => {
  const [x, y] = [orderKey(a), orderKey(b)]
  return x[0] - y[0] || x[1] - y[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** `limits` with `fresh` replacing or adding limits by id, keeping the ones `fresh` doesn't mention, in order. */
export const mergeLimits = (limits: ReadonlyArray<UsageLimit>, fresh: ReadonlyArray<UsageLimit>): Array<UsageLimit> => {
  const out = [...limits]
  for (const l of fresh) {
    const i = out.findIndex((x) => x.id === l.id)
    if (i >= 0) out[i] = l
    else out.push(l)
  }
  return out.toSorted(order)
}

/** Whether `l` is used up and hasn't reset by `now` (ms). */
const spent = (l: UsageLimit, now: number): boolean => {
  if (l.percent < 100) return false
  const at = l.resets_at !== null ? parseTime(l.resets_at) : null
  return at === null || at > now
}

/**
 * Whether an account can't be used until a limit resets: its session or weekly limit (the ones every model counts
 * against) is used up and hasn't reset by `now` (ms). A model's own weekly limit used up only stops that model.
 */
export const usedUp = (account: UsageAccount, now: number): boolean => account.limits.some((l) => (l.id === "session" || l.id === "weekly") && spent(l, now))

/** Ones with room first (when `room` counts), then used ones, then by when they reset (none last). */
const poolKey = (l: UsageLimit, now: number, room: boolean): readonly [number, number, number] => [
  room && spent(l, now) ? 1 : 0,
  l.percent > 0 ? 0 : 1,
  (l.resets_at !== null ? parseTime(l.resets_at) : null) ?? Infinity,
]
const before = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let i = 0; i < a.length; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0]
    if (x !== y) return x < y
  }
  return false
}

/**
 * A pool's limits from its accounts' at `now` (ms): what's left of the pool, as the proxy serves it. Accounts without
 * numbers are left out, and so are used-up ones (`usedUp`) while any other isn't: the proxy sends them nothing until
 * they reset. Of the rest, each limit is the one of the account where it has room left (a model's own limit can be
 * used up on one account and not on another) and has been used (at 0% a window hasn't really begun) and ends first
 * (the usage that's lost soonest if it isn't spent). A limit with no reset time comes after those with one. When every
 * account is used up, room left doesn't count: each limit is the used one that ends first.
 */
export const poolLimits = (accounts: ReadonlyArray<UsageAccount>, now: number): Array<UsageLimit> => {
  const free = accounts.filter((a) => a.limits.length > 0 && !usedUp(a, now))
  const room = free.length > 0
  const out: Array<UsageLimit> = []
  for (const l of (room ? free : accounts).flatMap((a) => a.limits)) {
    const i = out.findIndex((x) => x.id === l.id)
    const have = out[i]
    if (have === undefined) out.push({ ...l })
    else if (before(poolKey(l, now, room), poolKey(have, now, room))) out[i] = { ...l }
  }
  return out
}

/** What a `rate_limit_event` says: whether its config is out (until when; null when not known), or allowed again. */
export type OutNews = { readonly _tag: "Out"; readonly until: Timestamp | null } | { readonly _tag: "Allowed" } | { readonly _tag: "Unsaid" }

/** What a Claude Code `rate_limit_event` (the whole line) says of its config's usage. */
export const readRateLimit = (v: unknown): { readonly out: OutNews; readonly limits: Array<UsageLimit> } => {
  const info = field(v, "rate_limit_info")
  const status = field(info, "status")
  // A plan with extra usage reports its used-up limit as rejected while its turns go on, on the extra usage (as
  // Claude Code works out `isUsingOverage`).
  const overageStatus = field(info, "overageStatus")
  const overage = field(info, "isUsingOverage") === true || overageStatus === "allowed" || overageStatus === "allowed_warning"
  const resetsAt = field(info, "resetsAt")
  const out: OutNews =
    typeof status !== "string"
      ? { _tag: "Unsaid" }
      : status === "rejected" && !overage
        ? { _tag: "Out", until: typeof resetsAt === "number" && Number.isInteger(resetsAt) ? timestamp(resetsAt) : null }
        : // Allowed again (or on extra usage), whatever said it was out before.
          { _tag: "Allowed" }
  const windows = field(info, "unifiedWindows")
  const limits: Array<UsageLimit> = []
  for (const [key, id, label] of [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly", "Weekly"],
  ] as const) {
    const w = field(windows, key)
    const util = field(w, "utilization")
    if (typeof util !== "number") continue
    const r = field(w, "resetsAt")
    limits.push({ id, label, percent: Math.round(util * 1000) / 10, resets_at: typeof r === "number" && Number.isInteger(r) ? rfc3339(r) : null })
  }
  return { out, limits }
}

/**
 * Whether a `rate_limit_event` showed a 5-hour window, if it showed any rate limits at all (null otherwise). The first
 * request after a window ends reports it as its `rateLimitType` but leaves it out of `unifiedWindows`, so either counts.
 */
export const showsFiveHour = (v: unknown): boolean | null => {
  const info = field(v, "rate_limit_info")
  const windows = field(info, "unifiedWindows")
  const type = field(info, "rateLimitType")
  if (!isPlainObject(windows) && typeof type !== "string") return null
  return isPlainObject(field(windows, "five_hour")) || type === "five_hour"
}

/**
 * Codex refused a turn (`usageLimitExceeded`) without saying which limit: out until the latest reset of the limits it
 * last reported as used up, or null when none is known.
 */
export const codexOutUntil = (limits: ReadonlyArray<UsageLimit>): Timestamp | null => {
  let until: number | null = null
  for (const l of limits) {
    if (l.percent < 100 || l.resets_at === null) continue
    const t = parseTime(l.resets_at)
    if (t !== null && (until === null || t > until)) until = t
  }
  return until === null ? null : timestamp(Math.floor(until / 1000))
}
