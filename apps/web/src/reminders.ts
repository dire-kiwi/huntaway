import type { Task } from "./api";

/** Hosts from this API version on can star tasks and set reminders on them. */
export const REMINDERS_API = 48;

/** The tasks in the sidebar's Starred section: by project, in the order of `projectIds` (the sidebar's), then by number. */
export function starredTasks(tasks: Task[], projectIds: string[]) {
  const order = (t: Task) => {
    const i = projectIds.indexOf(t.project_id ?? "");
    return i < 0 ? projectIds.length : i;
  };
  return tasks.filter((t) => t.starred && t.kind !== "review").sort((a, b) => order(a) - order(b) || a.number - b.number);
}

/** The tasks in the sidebar's Reminders section, soonest first. */
export const reminderTasks = (tasks: Task[]) =>
  tasks.filter((t) => t.remind_at && t.kind !== "review").sort((a, b) => Date.parse(a.remind_at!) - Date.parse(b.remind_at!));

/** Whether a task's reminder has come round. */
export const isDue = (t: Pick<Task, "remind_at">, now: number) => !!t.remind_at && Date.parse(t.remind_at) <= now;

/** The next reminder still to come, in ms from `now`, to know when to look again. */
export function nextDue(tasks: Task[], now: number) {
  const later = tasks.map((t) => (t.remind_at ? Date.parse(t.remind_at) - now : NaN)).filter((ms) => ms > 0);
  return later.length ? Math.min(...later) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a reminder is, briefly: "in 12m", "in 5h", "Tue 09:00", "12 Nov", or "due" once it has come round. */
export function reminderLabel(iso: string, now: number) {
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (ms <= 0) return "due";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  if (ms < 12 * 3600_000) return `in ${Math.round(ms / 3600_000)}h`;
  if (ms < 6 * 86400_000) return `${DAYS[at.getDay()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** 9:00 on the day `days` after `from`'s, in local time. */
function morning(from: Date, days: number) {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** The quick choices for a reminder, from `now`. */
export function reminderPresets(now: Date): { label: string; at: Date }[] {
  // Monday, a week from today if that's a Monday.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: "In 1 hour", at: new Date(now.getTime() + 3600_000) },
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * 3600_000) },
    { label: "Tomorrow at 9:00", at: morning(now, 1) },
    { label: "Next Monday at 9:00", at: morning(now, toMonday) },
  ];
}

/** A time as a `datetime-local` input's value, in local time. */
export function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` input's value as an ISO time, or null if it isn't one. */
export function fromLocalInput(v: string) {
  const d = new Date(v);
  return v && !isNaN(d.getTime()) ? d.toISOString() : null;
}
