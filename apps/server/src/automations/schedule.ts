import { Cron, DateTime, Option, Result } from "effect"
import type { ActiveHours, HostTimeZone, Trigger } from "@huntaway/contracts"

// When an automation's schedule next runs, in the host's time zone (huntaway's automations/check.ts and cron.ts;
// docs/plan/inventory/06-integrations.md 2.3): `Cron` and `DateTime` from `effect` in place of the old hand-rolled
// offset arithmetic. Times are epoch milliseconds; a zone is a `DateTime.TimeZone` (the host's, `DateTime.zoneMakeLocal`).
// Plain functions: no clock, no I/O.
//
// Daylight saving: a time of day that doesn't exist that day (the clocks went forward over it) runs at the first time
// after the gap, as the old scheduler did (`Cron.next` alone would run it as long after the gap as it was into it); one
// that happens twice (they went back) runs at the first of the two, once.

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

/** A time zone. */
export type Zone = DateTime.TimeZone

const zoned = (zone: Zone, t: number) => DateTime.makeZonedUnsafe(t, { timeZone: zone })

/** The local date and time of `t` in `zone`, with its weekday (0 is Sunday). */
export const localParts = (zone: Zone, t: number) => DateTime.toParts(zoned(zone, t))

/** How far ahead of UTC `zone`'s clocks are at `t`, in milliseconds. */
export const offsetAt = (zone: Zone, t: number): number => DateTime.zonedOffset(zoned(zone, t))

/** A wall-clock time as milliseconds whose UTC fields are it (a naive date and time); null if it isn't a real one. */
export const naive = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | null => {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const made = DateTime.make({ year, month, day, hour, minute, second, millisecond: 0 })
  if (Option.isNone(made)) return null
  const p = DateTime.toPartsUtc(made.value)
  return p.year === year && p.month === month && p.day === day ? DateTime.toEpochMillis(made.value) : null
}

/** `t`'s local time in `zone` as a naive date and time (see `naive`). */
export const toLocal = (zone: Zone, t: number): number => t + offsetAt(zone, t)

/** The earliest moment whose local time in `zone` is `local` (a naive date and time), or null in a gap. */
export const fromLocal = (zone: Zone, local: number): number | null => {
  const made = DateTime.makeZoned(local, { timeZone: zone, adjustForTimeZone: true, disambiguation: "earlier" })
  if (Option.isNone(made)) return null
  const t = DateTime.toEpochMillis(made.value)
  return toLocal(zone, t) === local ? t : null
}

/** The first moment at or after local time `local` in `zone`: itself, or in a gap, the first minute after it. */
export const resolveLocal = (zone: Zone, local: number): number | null => {
  for (let m = 0; m <= 24 * 60; m++) {
    const t = fromLocal(zone, local + m * MINUTE)
    if (t !== null) return t
  }
  return null
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** `%Y-%m-%d %H:%M` of `t` in `zone`. */
export const formatLocal = (zone: Zone, t: number): string => {
  const p = localParts(zone, t)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** An offset in milliseconds as `%:z` writes it: `+13:00`. */
export const offsetText = (ms: number): string => {
  const secs = Math.round(ms / 1000)
  const a = Math.abs(secs)
  return `${secs < 0 ? "-" : "+"}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`
}

/** The local date, time and offset of `t` in `zone` as RFC 3339 (`{{now}}`). */
export const nowText = (zone: Zone, t: number): string => {
  const p = localParts(zone, t)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetText(offsetAt(zone, t))}`
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `%a %-d %b %H:%M` of `t` in `zone`, e.g. `Thu 5 Nov 09:30`. */
export const whenText = (zone: Zone, t: number): string => {
  const p = localParts(zone, t)
  return `${DAY_NAMES[p.weekDay] ?? ""} ${p.day} ${MONTH_NAMES[p.month - 1] ?? ""} ${pad(p.hour)}:${pad(p.minute)}`
}

/** `%a %H:%M` of `t` in `zone`. */
export const dayTimeText = (zone: Zone, t: number): string => {
  const p = localParts(zone, t)
  return `${DAY_NAMES[p.weekDay] ?? ""} ${pad(p.hour)}:${pad(p.minute)}`
}

/** The host's time zone as the settings show it: its name, and its offset at `t`. */
export const timeZoneOf = (zone: Zone, t: number): HostTimeZone => ({
  name: DateTime.isTimeZoneNamed(zone) ? zone.id : null,
  offset: offsetText(offsetAt(zone, t)),
})

/** The start of `t`'s day in `zone` (its first moment, past any gap). */
export const dayStart = (zone: Zone, t: number): number => {
  const p = localParts(zone, t)
  const midnight = naive(p.year, p.month, p.day)
  return (midnight === null ? null : resolveLocal(zone, midnight)) ?? t
}

/** A UTC RFC 3339 time (`2026-11-04T20:30:00Z`, with or without fractions or an offset), as epoch milliseconds. */
export const parseTime = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u.test(s)) return null
  const t = DateTime.make(s.replace(" ", "T"))
  return Option.isSome(t) ? DateTime.toEpochMillis(t.value) : null
}

/** `t` as rows store it: RFC 3339 UTC with milliseconds, so times sort as strings. */
export const isoOf = (t: number): string => DateTime.formatIso(DateTime.makeUnsafe(t))

/** When an `at` trigger fires: a UTC RFC 3339 time, or a local `YYYY-MM-DD HH:MM` (or with a `T`, or seconds) in `zone`. */
export const parseAt = (at: string, zone: Zone): number | null => {
  const s = at.trim()
  const t = parseTime(s)
  if (t !== null) return t
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/u.exec(s)
  if (m === null) return null
  const local = naive(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  return local === null ? null : fromLocal(zone, local)
}

/** A time of day (`H:MM`), as minutes from midnight. */
export const parseDailyTime = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{1,2})$/u.exec(t.trim())
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h < 24 && mi < 60 ? h * 60 + mi : null
}

/** A weekday's days from Monday. */
export const weekdayIndex = (d: string): number | null => {
  const i = WEEKDAYS.findIndex((w) => w === d.trim().toLowerCase())
  return i < 0 ? null : i
}

/** Cron's day of the week (0 is Sunday) of days from Monday. */
const cronWeekday = (fromMonday: number) => (fromMonday + 1) % 7

// ---- cron ----

const ALIASES: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

/**
 * A cron expression in `zone`: five fields (`minute hour day-of-month month day-of-week`), each `*`, a number or name, a
 * range, a step or a list of them, or `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`,
 * `@annually`. Sunday is 0 or 7. A day must match both day fields if either starts with `*`, and either otherwise
 * (Vixie cron's rule, which `Cron` keeps). Why it can't be read, as a sentence.
 */
export const parseCron = (expr: string, zone: Zone): Result.Result<Cron.Cron, string> => {
  const e = expr.trim().toLowerCase()
  const fields = (ALIASES[e] ?? e).split(/\s+/u).filter((x) => x !== "")
  if (fields.length !== 5) {
    return Result.fail("a cron expression has five fields: minute hour day-of-month month day-of-week (e.g. 0 8 * * mon-fri)")
  }
  return Result.mapError(Cron.parse(fields.join(" "), zone), (err) => `the cron expression ${expr.trim()} can't be read: ${err.message}`)
}

const cronNextOf = Option.liftThrowable((cron: Cron.Cron, after: number) => Cron.next(cron, after).getTime())

/**
 * The first time after `after` that `cron` (made in `zone`) matches, or null if it never does (`Cron` gives up after
 * enough steps for four years). A time in a gap runs as the gap ends (see the top).
 */
export const cronNext = (cron: Cron.Cron, zone: Zone, after: number): number | null => {
  let from = after
  for (let i = 0; i < 4; i++) {
    const found = cronNextOf(cron, from)
    if (Option.isNone(found)) return null
    const r = found.value
    if (Cron.match(cron, r)) return r
    // In a gap: `Cron` moved its wall time on by the gap's length. The first moment after the gap instead.
    const gap = offsetAt(zone, r) - offsetAt(zone, r - DAY)
    const after_gap = resolveLocal(zone, toLocal(zone, r) - gap)
    if (after_gap !== null && after_gap > after) return after_gap
    from = r
  }
  return null
}

/** A time of day (minutes from midnight) on some weekdays (days from Monday; any day if none) as a cron in `zone`. */
const dailyCron = (zone: Zone, at: number, days: ReadonlyArray<number>) =>
  Cron.make({ minutes: [at % 60], hours: [Math.floor(at / 60)], days: [], months: [], weekdays: days.map(cronWeekday), tz: zone })

/** The first time after `after` that's `at` (minutes from midnight) on one of `days` (days from Monday; any if none). */
export const nextDaily = (zone: Zone, at: number, days: ReadonlyArray<number>, after: number): number | null => cronNext(dailyCron(zone, at, days), zone, after)

/** When a schedule next runs after `now`, in `zone`; none for a webhook, a passed `at` or a cron that never matches. */
export const nextAfter = (trigger: Trigger, now: number, zone: Zone): number | null => {
  switch (trigger.kind) {
    case "interval":
      return now + trigger.every_minutes * MINUTE
    case "daily": {
      const at = parseDailyTime(trigger.time)
      if (at === null) return null
      const days = trigger.weekdays.flatMap((d) => {
        const i = weekdayIndex(d)
        return i === null ? [] : [i]
      })
      return nextDaily(zone, at, days, now)
    }
    case "cron": {
      const cron = parseCron(trigger.expr, zone)
      return Result.isSuccess(cron) ? cronNext(cron.success, zone, now) : null
    }
    case "at": {
      const t = parseTime(trigger.at)
      return t !== null && t > now ? t : null
    }
    case "webhook":
      return null
    default:
      return null
  }
}

const hoursOf = (h: ActiveHours) => {
  const start = parseDailyTime(h.start)
  const end = parseDailyTime(h.end)
  if (start === null || end === null) return null
  const days = h.weekdays.flatMap((d) => {
    const i = weekdayIndex(d)
    return i === null ? [] : [i]
  })
  return { start, end, days }
}

/** Whether `t` is in active hours `h`. Hours past midnight belong to the day they started on. */
export const activeContains = (h: ActiveHours, t: number, zone: Zone): boolean => {
  const times = hoursOf(h)
  if (times === null) return true
  const p = localParts(zone, t)
  const time = p.hour * 60 + p.minute
  const today = (p.weekDay + 6) % 7
  const on = (d: number) => times.days.length === 0 || times.days.includes((d + 7) % 7)
  if (times.start < times.end) return on(today) && time >= times.start && time < times.end
  return (time >= times.start && on(today)) || (time < times.end && on(today - 1))
}

/** When active hours `h` next start after `t`. */
const activeNextStart = (h: ActiveHours, t: number, zone: Zone): number | null => {
  const times = hoursOf(h)
  return times === null ? null : nextDaily(zone, times.start, times.days, t)
}

/** Active hours as the deliveries list says them, e.g. `08:00–22:00 on mon, tue`. */
export const activeText = (h: ActiveHours): string => `${h.start}–${h.end}${h.weekdays.length > 0 ? ` on ${h.weekdays.join(", ")}` : ""}`

/**
 * `when`, or if it's outside the active hours, the schedule's first time in them: an interval starts again when they
 * do, a time of day or cron expression waits for its next time in them. An `at` keeps its time.
 */
export const align = (trigger: Trigger, active: ActiveHours | null, when: number, zone: Zone): number | null => {
  if (active === null || trigger.kind === "at" || trigger.kind === "webhook") return when
  let t = when
  // Each round moves on to the next window at least, so a year's worth is plenty.
  for (let i = 0; i < 800; i++) {
    if (activeContains(active, t, zone)) return t
    const start = activeNextStart(active, t, zone)
    if (start === null) return null
    const n = trigger.kind === "interval" ? start : nextAfter(trigger, start - 1000, zone)
    if (n === null) return null
    t = n
  }
  return null
}

/** When a schedule next runs after `now`, in its active hours (if it has them). */
export const nextRun = (trigger: Trigger, active: ActiveHours | null, now: number, zone: Zone): number | null => {
  const n = nextAfter(trigger, now, zone)
  return n === null ? null : align(trigger, active, n, zone)
}
