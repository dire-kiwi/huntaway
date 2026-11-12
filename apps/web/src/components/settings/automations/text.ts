import type { HostProject as Project } from "@huntaway/client"
import { nowMillis } from "../../../state/clock"
import { localeString, millisOf, toJson } from "../../ui"
import type { ActiveHours, Filter, FilterOp, HostTimeZone, Trigger, Weekday } from "@huntaway/contracts"

export type TimeZone = HostTimeZone

/** What an automation belongs to: a project, or (with none) a profile, whose routines wake its assistant. */
export interface Owner {
  hostId: string
  profileId: string
  project?: Project | undefined
}

export const DAY_LABELS: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" }

export const OP_LABELS: Record<FilterOp, string> = {
  equals: "is",
  not_equals: "isn't",
  starts_with: "starts with",
  contains: "contains",
  in: "is one of",
  not_in: "isn't any of",
  exists: "is set",
  not_exists: "isn't set",
}

/** The filters the form has fields of their own for: the event, action and labels being one of a list. */
export const SIMPLE_FILTERS = ["event", "action", "labels"] as const

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function everyText(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${plural(minutes / 1440, "day")}`
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${plural(minutes / 60, "hour")}`
  return `Every ${plural(minutes, "minute")}`
}

function daysText(days: ReadonlyArray<Weekday>) {
  if (!days.length || days.length === 7) return "every day"
  const key = days.join(",")
  if (key === "mon,tue,wed,thu,fri") return "weekdays"
  if (key === "sat,sun") return "weekends"
  return days.map((d) => DAY_LABELS[d]).join(", ")
}

/** A filter's value as text: a list joined with commas, a string as it is, anything else as its JSON. */
export const valueText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" ? v : v == null ? "" : toJson(v))

export function filterText(f: Filter) {
  return f.op === "exists" || f.op === "not_exists" ? `${f.path} ${OP_LABELS[f.op]}` : `${f.path} ${OP_LABELS[f.op]} ${valueText(f.value)}`
}

/** What starts an automation, e.g. "Every hour" or "At 09:00 on weekdays (Pacific/Auckland)". */
export function triggerText(t: Trigger, tz: TimeZone | null) {
  if (t.kind === "interval") return everyText(t.every_minutes)
  if (t.kind === "daily") return `At ${t.time} on ${daysText(t.weekdays)}${tz?.name ? ` (${tz.name})` : ""}`
  if (t.kind === "cron") return `Cron ${t.expr}${tz?.name ? ` (${tz.name})` : ""}`
  if (t.kind === "at") return `Once, ${localTime(t.at)}`
  const parts = ["Webhook"]
  if (t.filters.length) parts.push(`when ${t.filters.map(filterText).join(" and ")}`)
  if (t.coalesce_seconds) parts.push(`coalescing ${t.coalesce_seconds}s`)
  return parts.join(", ")
}

/** The hours a run may start in, e.g. "08:00–22:00 on weekdays". */
export function activeText(h: ActiveHours) {
  return `${h.start}–${h.end}${h.weekdays.length ? ` on ${daysText(h.weekdays)}` : ""}`
}

/** Dollars, to the cent (or a tenth of one, under a dollar). */
export const usd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`

/** "in 5m", "in 3h": how long until a time (from `now`, in milliseconds). */
export function timeUntil(iso: string, now: number = nowMillis()) {
  const s = Math.max(0, (millisOf(iso) - now) / 1000)
  if (s < 60) return "in under a minute"
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  if (s < 86400 * 2) return `in ${Math.round(s / 3600)}h`
  return `in ${Math.round(s / 86400)}d`
}

export const localTime = (iso: string) => localeString(iso, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, [])
