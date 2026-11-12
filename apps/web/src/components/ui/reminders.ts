import type { HostTask as Task } from "@huntaway/client"
import { isoOf, localMillis, localParts, millisOf } from "./dates"

/** The tasks in the sidebar's Starred section: by project, in the order of `projectIds` (the sidebar's), then by number. */
export function starredTasks(tasks: ReadonlyArray<Task>, projectIds: ReadonlyArray<string>): Task[] {
  const order = (t: Task) => {
    const i = projectIds.indexOf(t.project_id ?? "")
    return i < 0 ? projectIds.length : i
  }
  return tasks.filter((t) => t.starred && t.kind !== "review").toSorted((a, b) => order(a) - order(b) || a.number - b.number)
}

/** The tasks in the sidebar's Reminders section, soonest first. */
export const reminderTasks = (tasks: ReadonlyArray<Task>): Task[] =>
  tasks.filter((t) => t.remind_at && t.kind !== "review").toSorted((a, b) => Date.parse(a.remind_at ?? "") - Date.parse(b.remind_at ?? ""))

/** Whether a task's reminder has come round. */
export const isDue = (t: Pick<Task, "remind_at">, now: number) => !!t.remind_at && Date.parse(t.remind_at) <= now

/** The next reminder still to come, in ms from `now`, to know when to look again. */
export function nextDue(tasks: ReadonlyArray<Task>, now: number) {
  const later = tasks.map((t) => (t.remind_at ? Date.parse(t.remind_at) - now : NaN)).filter((ms) => ms > 0)
  return later.length ? Math.min(...later) : null
}

const pad = (n: number) => String(n).padStart(2, "0")
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** When a reminder is, briefly: "in 12m", "in 5h", "Tue 09:00", "12 Nov", or "due" once it has come round. */
export function reminderLabel(iso: string, now: number) {
  const ms = millisOf(iso) - now
  if (ms <= 0) return "due"
  const at = localParts(iso)
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${Math.max(1, mins)}m`
  if (ms < 12 * 3600_000) return `in ${Math.round(ms / 3600_000)}h`
  if (ms < 6 * 86400_000) return `${DAYS[at.weekDay]} ${pad(at.hour)}:${pad(at.minute)}`
  return `${at.day} ${MONTHS[at.month - 1]}`
}

/** 9:00 on the day `days` after `from`'s, in local time (milliseconds). */
function morning(from: number, days: number) {
  const d = localParts(from)
  return localMillis({ year: d.year, month: d.month, day: d.day + days, hour: 9, minute: 0, second: 0, millisecond: 0 })
}

/** The quick choices for a reminder, from `now` (milliseconds; so is each one's `at`). */
export function reminderPresets(now: number): { label: string; at: number }[] {
  // Monday, a week from today if that's a Monday.
  const toMonday = (8 - localParts(now).weekDay) % 7 || 7
  return [
    { label: "In 1 hour", at: now + 3600_000 },
    { label: "In 3 hours", at: now + 3 * 3600_000 },
    { label: "Tomorrow at 9:00", at: morning(now, 1) },
    { label: "Next Monday at 9:00", at: morning(now, toMonday) },
  ]
}

/** A time (milliseconds) as a `datetime-local` input's value, in local time. */
export function toLocalInput(at: number) {
  const d = localParts(at)
  return `${d.year}-${pad(d.month)}-${pad(d.day)}T${pad(d.hour)}:${pad(d.minute)}`
}

/** A `datetime-local` input's value (a wall-clock time here) as an ISO time, or null if it isn't one. */
export function fromLocalInput(v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v)
  if (!m) return null
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = m.slice(1).map((n) => Number(n ?? 0))
  return isoOf(localMillis({ year, month, day, hour, minute, second, millisecond: 0 }))
}
