import { DateTime, Option } from "effect"
import { rfc3339Utc } from "../../tasks/checks.ts"

// When `create_task` and `update_task` remind the user of a task (docs/plan/inventory/03-mcp.md 2.5; the old
// mcp/tools/tasks.ts `reminder_time`): what an agent writes, made a time the task can keep.

const MINUTE = 60_000

const UNITS: ReadonlyArray<readonly [ReadonlyArray<string>, number]> = [
  [["m", "min", "mins", "minute", "minutes"], MINUTE],
  [["h", "hr", "hrs", "hour", "hours"], 60 * MINUTE],
  [["d", "day", "days"], 24 * 60 * MINUTE],
  [["w", "wk", "week", "weeks"], 7 * 24 * 60 * MINUTE],
]

/** A delay like `1h30m`, `in 2 days` or `1d 12h`, in milliseconds; null if it isn't one. Each number is at most 10 000. */
const delay = (v: string): number | null => {
  const rest = (v.startsWith("in ") ? v.slice(3) : v).toLowerCase().replace(/[\s,]/g, "")
  let total = 0
  let any = false
  for (let i = 0; i < rest.length;) {
    const m = /^(\d*)([a-z]*)/.exec(rest.slice(i))
    const n = m?.[1] ?? ""
    const unit = m?.[2] ?? ""
    if (n === "") return null
    const num = Number(n)
    if (num > 10_000) return null
    const ms = UNITS.find(([names]) => names.includes(unit))?.[1]
    if (ms === undefined) return null
    total += num * ms
    any = true
    i += n.length + unit.length
  }
  return any ? total : null
}

/**
 * A reminder's time, from what an agent passes: a delay from `now` (`30m`, `2h`, `1d 12h`, `in 3 days`, `1w`), an
 * RFC 3339 time (kept as given), or a date and time (or a date alone, at 9:00) in the host's time zone `zone`. Blank is
 * `""`, which clears the reminder. Null if it's none of those.
 */
export const reminderTime = (given: string, now: DateTime.Utc, zone: DateTime.TimeZone): string | null => {
  const v = given.trim()
  if (v === "") return ""
  if (rfc3339Utc(v) !== null) return v
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v)
  if (local !== null) {
    const [year = 0, month = 0, day = 0] = local.slice(1, 4).map(Number)
    const [hours, minutes, seconds] = local[4] === undefined ? [9, 0, 0] : [Number(local[4]), Number(local[5]), local[6] === undefined ? 0 : Number(local[6])]
    if (hours > 23 || minutes > 59 || seconds > 59) return null
    const at = DateTime.makeZoned({ year, month, day, hour: hours, minute: minutes, second: seconds }, { timeZone: zone, adjustForTimeZone: true })
    if (Option.isNone(at)) return null
    // A date that doesn't exist (2026-02-30) isn't one.
    const parts = DateTime.toParts(at.value)
    if (parts.year !== year || parts.month !== month || parts.day !== day) return null
    return DateTime.formatIso(at.value)
  }
  const ms = delay(v)
  return ms === null ? null : DateTime.formatIso(DateTime.add(now, { milliseconds: ms }))
}

/** What an agent is told when `remind_at` is none of those. */
export const BAD_REMIND_AT =
  "remind_at must be a delay like 30m, 2h, 3d or 1w, a time like 2026-05-01T09:00:00Z (or 2026-05-01 09:00 in the host's time zone), " +
  "or an empty string to clear the reminder"
