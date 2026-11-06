// Port of server/src/integrations/automations/check.rs: checking what the API is given (triggers, actions), and when
// a trigger next fires.
import { readlinkSync } from "node:fs";
import * as db from "../../db.ts";
import type { Conn, Project, Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import * as api from "../../api.ts";
import * as documents from "../../agent/documents.ts";
import { byte_len, err_str } from "../../util.ts";
import {
  ActiveHours_from_json,
  MAX_COALESCE_SECONDS,
  MAX_FILTERS,
  MAX_INTERVAL_MINUTES,
  MAX_TEXT_CHARS,
  MIN_INTERVAL_MINUTES,
  WEEKDAYS,
  bad,
  fmt,
  parse_time,
  set_labels,
  type Action,
  type ActiveHours,
  type Automation,
  type Trigger,
} from "../automations.ts";
import { Cron_next_after, Cron_parse } from "./cron.ts";
import { valid_path, wanted } from "./delivery.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * A time zone (chrono's `TimeZone`): how far ahead of UTC (in seconds) its clocks are at a moment. `Local` is the
 * host's.
 */
export interface Tz {
  offset(utc_ms: number): number;
}

export const Local: Tz = { offset: (ms) => -new Date(ms).getTimezoneOffset() * 60 };

/** A fixed offset (seconds east of UTC). */
export function fixed(secs: number): Tz {
  return { offset: () => secs };
}

/** The local time at `utc` in `tz`, as milliseconds whose UTC fields are the local ones (a NaiveDateTime). */
export function to_local(tz: Tz, utc: number): number {
  return utc + tz.offset(utc) * 1000;
}

/** The earliest moment whose local time in `tz` is `local` (see to_local), or null in a gap (`.earliest()`). */
export function from_local(tz: Tz, local: number): number | null {
  const offsets = new Set([tz.offset(local - DAY), tz.offset(local), tz.offset(local + DAY)]);
  let best: number | null = null;
  for (const o of offsets) {
    const utc = local - o * 1000;
    if (tz.offset(utc) === o && (best === null || utc < best)) best = utc;
  }
  return best;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A local time's `%Y-%m-%d`, `%H:%M` and the like (from to_local's milliseconds). */
export function local_parts(local: number) {
  const d = new Date(local);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/** `%Y-%m-%d %H:%M` of `utc` in `tz`. */
export function format_local(tz: Tz, utc: number): string {
  const p = local_parts(to_local(tz, utc));
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** An offset as `%:z` writes it: `+13:00`. */
export function offset_str(secs: number): string {
  const sign = secs < 0 ? "-" : "+";
  const a = Math.abs(secs);
  return `${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
}

/** A time of day, as minutes from midnight. */
function parse_daily_time(t: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]),
    mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Days from Monday. */
function weekday(d: string): number | null {
  const i = WEEKDAYS.indexOf(d.trim().toLowerCase());
  return i < 0 ? null : i;
}

/** Rust's `{:?}` of a list of strings. */
const debug_list = (l: string[]) => `[${l.map((x) => JSON.stringify(x)).join(", ")}]`;

function check_weekdays(weekdays: string[]): string[] {
  let ds: number[] = [];
  for (const d of weekdays) {
    const w = weekday(d);
    if (w === null) throw bad(`weekdays must be from ${debug_list(WEEKDAYS)}`);
    ds.push(w);
  }
  ds = [...new Set(ds)].sort((a, b) => a - b);
  return ds.length === 7 ? [] : ds.map((d) => WEEKDAYS[d]);
}

/** Whether `y-m-d h:mi:s` is a real date and time (chrono's NaiveDateTime parse), as milliseconds whose UTC fields are it. */
function naive(y: number, mo: number, d: number, h: number, mi: number, sec: number): number | null {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec);
  const x = new Date(t);
  return x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d ? t : null;
}

/** When an `at` trigger fires: a UTC RFC 3339 time, or a local `YYYY-MM-DD HH:MM` (or with a `T`, or seconds) in `tz`. */
export function parse_at(at: string, tz: Tz): number | null {
  at = at.trim();
  const t = parse_time(at);
  if (t !== null) return t;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(at);
  if (!m) return null;
  const local = naive(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return local === null ? null : from_local(tz, local);
}

/** A trigger as it's stored: checked, and tidied (weekdays in order, each once). */
export function check_trigger(t: Trigger): Trigger {
  if (t.kind === "interval") {
    if (!(t.every_minutes >= MIN_INTERVAL_MINUTES && t.every_minutes <= MAX_INTERVAL_MINUTES)) {
      throw bad(`every_minutes must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} (31 days)`);
    }
    return { kind: "interval", every_minutes: t.every_minutes };
  }
  if (t.kind === "daily") {
    const at = parse_daily_time(t.time);
    if (at === null) throw bad("time must be a time of day like 09:30");
    return { kind: "daily", time: `${pad(Math.floor(at / 60))}:${pad(at % 60)}`, weekdays: check_weekdays(t.weekdays) };
  }
  if (t.kind === "cron") {
    const expr = t.expr
      .split(/\s+/)
      .filter((x) => x !== "")
      .join(" ");
    let cron;
    try {
      cron = Cron_parse(expr);
    } catch (e) {
      throw bad(String(e));
    }
    if (Cron_next_after(cron, Local, Date.now()) === null) throw bad(`the cron expression ${expr} never matches`);
    return { kind: "cron", expr };
  }
  if (t.kind === "at") {
    const when = parse_at(t.at, Local);
    if (when === null) throw bad("at must be a time like 2026-11-05 09:30 (in the host's time zone) or 2026-11-04T20:30:00Z");
    return { kind: "at", at: fmt(when) };
  }
  const { filters, coalesce_seconds, coalesce_key } = t;
  if (filters.length > MAX_FILTERS) throw bad(`a webhook can have at most ${MAX_FILTERS} filters`);
  for (const f of filters) {
    if (!valid_path(f.path.trim())) {
      throw bad(`filter path ${JSON.stringify(f.path)} must name a value, like event, action, labels or body.issue.title`);
    }
    const needs_value = !(f.op === "exists" || f.op === "not_exists");
    if (needs_value && wanted(f).length === 0) throw bad(`the filter on ${f.path.trim()} needs a value`);
  }
  if (coalesce_seconds > MAX_COALESCE_SECONDS) throw bad(`coalesce_seconds must be at most ${MAX_COALESCE_SECONDS}`);
  if (byte_len(coalesce_key) > 500) throw bad("coalesce_key is too long");
  return {
    kind: "webhook",
    filters: filters.map((f) => ({ path: f.path.trim(), op: f.op, value: f.value })),
    coalesce_seconds,
    coalesce_key: coalesce_key.trim(),
  };
}

const chars = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** The hours a run may start in, as they're stored (none for any time). */
export function check_active_hours(v: any): ActiveHours | null {
  if (v === null || v === undefined) return null;
  let h: ActiveHours;
  try {
    h = ActiveHours_from_json(v);
  } catch (e) {
    throw bad(`active_hours: ${err_str(e)}`);
  }
  const time = (t: string) => {
    const m = parse_daily_time(t);
    if (m === null) throw bad("active_hours' start and end must be times of day like 08:00");
    return m;
  };
  const [start, end] = [time(h.start), time(h.end)];
  if (start === end) throw bad("active_hours' start and end can't be the same (leave active_hours out for any time)");
  const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return { start: hm(start), end: hm(end), weekdays: check_weekdays(h.weekdays) };
}

/** A precheck command as it's stored (none for blank). */
export function check_precheck(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (typeof v === "string" && chars(v) <= 4000) return v.trim();
  throw bad("precheck must be a command of up to 4000 characters");
}

/** A budget a day as it's stored (none for no limit). */
export function check_budget(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v === 0) return null;
    if (v > 0 && v <= 10_000) return v;
  }
  throw bad("budget_usd must be a number of dollars from 0 (no limit) to 10000");
}

/** What an automation belongs to: a project, or for a routine, a profile. */
export type Owner = { project: Project } | { profile: string };

/** Rust's `Owner::profile_id`. */
export function owner_profile_id(o: Owner): string {
  return "project" in o ? o.project.profile_id : o.profile;
}

/** Rust's `Owner::project_id`. */
export function owner_project_id(o: Owner): string | null {
  return "project" in o ? o.project.id : null;
}

/** What `a` belongs to (its project must still be there). */
export function owner(c: Conn, a: Automation): Owner {
  if (a.project_id === null) return { profile: a.profile_id };
  const p = db.get_project(c, a.project_id);
  if (!p) throw ApiError.not_found("project");
  return { project: p };
}

/**
 * An action as it's stored: checked against the automation's project, so it can only make tasks
 * there, with its agent configs, and only message its tasks. A routine's (a profile's) can only
 * message its assistant, and a project's can't.
 */
export function check_action(c: Conn, owner: Owner, a: Action): Action {
  const blank = (v: string | null | undefined) => {
    const t = v?.trim();
    return t ? t : null;
  };
  if ("profile" in owner) {
    if (a.kind !== "message_assistant") throw bad("a routine (a profile's automation) can only message the assistant (message_assistant)");
    if (!a.message.trim()) throw bad("the message can't be blank");
    if (chars(a.message) > MAX_TEXT_CHARS) throw bad("the message is too long");
    return { kind: "message_assistant", message: a.message, mode: a.mode };
  }
  if (a.kind === "message_assistant") throw bad("message_assistant is for a profile's routines, not a project's automations");
  const project = owner.project;
  if (a.kind === "create_task") {
    const { title, description, labels, model, status, start } = a;
    if (!title.trim()) throw bad("the task's title can't be blank");
    if (chars(title) > 500 || chars(description) > MAX_TEXT_CHARS) throw bad("the task's title or description is too long");
    let task_type = blank(a.task_type);
    // A label as its type, as before API 71.
    const given = [...(labels ?? [])];
    if (task_type !== null && db.LABELS.includes(task_type)) {
      given.push(task_type);
      task_type = null;
    }
    let checked: string[];
    try {
      checked = (documents.check_labels(given) as string[]).map(String);
    } catch (e) {
      throw bad(e instanceof ApiError ? e.message : err_str(e));
    }
    if (task_type !== null && !db.TASK_TYPES.includes(task_type)) throw bad(`task_type must be one of ${debug_list(db.TASK_TYPES)}`);
    const effort = blank(a.effort);
    if (effort !== null && !db.THREAD_EFFORTS.includes(effort)) throw bad(`effort must be one of ${debug_list(db.THREAD_EFFORTS)}`);
    if (!["todo", "backlog"].includes(status)) throw bad("status must be todo or backlog (a task that's started moves to in_progress)");
    const claude_config_id = api.pick_config(c, project.profile_id, project, blank(a.claude_config_id));
    return set_labels(
      {
        kind: "create_task",
        title: title.trim(),
        description,
        task_type,
        claude_config_id: claude_config_id ?? null,
        model: blank(model),
        effort,
        status,
        start,
      },
      checked,
    );
  }
  if (!a.message.trim()) throw bad("the message can't be blank");
  if (chars(a.message) > MAX_TEXT_CHARS) throw bad("the message is too long");
  const t = target_task(c, project, a.task_id.trim());
  return { kind: "send_to_task", task_id: t.id, message: a.message };
}

/** The task a message goes to: one of the project's own tasks, never another project's (or another profile's). */
export function target_task(c: Conn, project: Project, task_id: string): Task {
  const t = db.get_task(c, task_id);
  if (!t) throw ApiError.not_found("task");
  if (t.kind === "task" && t.project_id === project.id) return t;
  throw bad("an automation can only send messages to tasks in its own project");
}

/** When a schedule next runs after `now`, in `tz`; none for a webhook. */
export function next_after(trigger: Trigger, now: number, tz: Tz): number | null {
  if (trigger.kind === "interval") return now + trigger.every_minutes * MINUTE;
  if (trigger.kind === "daily") {
    const at = parse_daily_time(trigger.time);
    if (at === null) return null;
    const ds = trigger.weekdays.map(weekday).filter((d): d is number => d !== null);
    return next_daily(tz, at, ds, now);
  }
  if (trigger.kind === "cron") {
    try {
      return Cron_next_after(Cron_parse(trigger.expr), tz, now);
    } catch {
      return null;
    }
  }
  if (trigger.kind === "at") {
    const t = parse_time(trigger.at);
    return t !== null && t > now ? t : null;
  }
  return null;
}

/** When a schedule next runs after `now`, in its active hours (if it has them): see `align`. */
export function next_run(trigger: Trigger, active: ActiveHours | null, now: number, tz: Tz): number | null {
  const n = next_after(trigger, now, tz);
  return n === null ? null : align(trigger, active, n, tz);
}

/**
 * `when`, or if it's outside the active hours, the schedule's first time in them: an interval starts again when they
 * do, a time of day or cron expression waits for its next time in them. An `at` keeps its time.
 */
export function align(trigger: Trigger, active: ActiveHours | null, when: number, tz: Tz): number | null {
  if (!active || trigger.kind === "at" || trigger.kind === "webhook") return when;
  // Each round moves on to the next window at least, so a year's worth is plenty.
  for (let i = 0; i < 800; i++) {
    if (ActiveHours_contains(active, when, tz)) return when;
    const start = ActiveHours_next_start(active, when, tz);
    if (start === null) return null;
    const n = trigger.kind === "interval" ? start : next_after(trigger, start - 1000, tz);
    if (n === null) return null;
    when = n;
  }
  return null;
}

function ActiveHours_times(h: ActiveHours): [number, number, number[]] | null {
  const start = parse_daily_time(h.start);
  const end = parse_daily_time(h.end);
  if (start === null || end === null) return null;
  return [start, end, h.weekdays.map(weekday).filter((d): d is number => d !== null)];
}

/** Whether `t` is in active hours `h`. Hours past midnight belong to the day they started on. */
export function ActiveHours_contains(h: ActiveHours, t: number, tz: Tz): boolean {
  const times = ActiveHours_times(h);
  if (!times) return true;
  const [start, end, ds] = times;
  const local = to_local(tz, t);
  const date = Math.floor(local / DAY) * DAY;
  const time = (local - date) / MINUTE;
  const on = (d: number) => ds.length === 0 || ds.includes((new Date(d).getUTCDay() + 6) % 7);
  if (start < end) return on(date) && time >= start && time < end;
  return (time >= start && on(date)) || (time < end && on(date - DAY));
}

/** When active hours `h` next start after `t`. */
function ActiveHours_next_start(h: ActiveHours, t: number, tz: Tz): number | null {
  const times = ActiveHours_times(h);
  return times ? next_daily(tz, times[0], times[2], t) : null;
}

/** Active hours as the deliveries list says them, e.g. `08:00–22:00 on mon, tue`. */
export function ActiveHours_text(h: ActiveHours): string {
  const ds = h.weekdays.length ? ` on ${h.weekdays.join(", ")}` : "";
  return `${h.start}–${h.end}${ds}`;
}

/**
 * The first time after `after` that's `at` (minutes from midnight) on one of `days` (days from Monday; any day if
 * none) in `tz`. A time that doesn't exist that day (the clocks went forward over it) is the first one after the gap;
 * one that happens twice (they went back) is the first of the two, so it runs once.
 */
export function next_daily(tz: Tz, at: number, days: number[], after: number): number | null {
  const l = local_parts(to_local(tz, after));
  const today = Date.UTC(l.y, l.mo - 1, l.d);
  // From the day before, in case `after`'s day there is the next day here.
  for (let offset = -1; offset <= 8; offset++) {
    const date = today + offset * DAY;
    const wd = (new Date(date).getUTCDay() + 6) % 7;
    if (days.length && !days.includes(wd)) continue;
    const local = date + at * MINUTE;
    let when = from_local(tz, local);
    // In a gap: the first minute after it.
    for (let m = 1; when === null && m <= 24 * 60; m++) when = from_local(tz, local + m * MINUTE);
    if (when !== null && when > after) return when;
  }
  return null;
}

/** The host's time zone, as the settings show it: its name where the system says, and its offset now. */
export function time_zone(): { name: string | null; offset: string } {
  let name: string | null = (process.env.TZ ?? "").replace(/^:+/, "") || null;
  if (name === null) {
    try {
      const link = readlinkSync("/etc/localtime");
      const i = link.indexOf("zoneinfo/");
      if (i >= 0) name = link.slice(i + "zoneinfo/".length);
    } catch {}
  }
  return { name, offset: offset_str(Local.offset(Date.now())) };
}
