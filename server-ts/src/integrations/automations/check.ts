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
  MAX_COALESCE_SECONDS,
  MAX_FILTERS,
  MAX_INTERVAL_MINUTES,
  MAX_TEXT_CHARS,
  MIN_INTERVAL_MINUTES,
  WEEKDAYS,
  bad,
  set_labels,
  type Action,
  type Trigger,
} from "../automations.ts";
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
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Days from Monday. */
function weekday(d: string): number | null {
  const i = WEEKDAYS.indexOf(d.trim().toLowerCase());
  return i < 0 ? null : i;
}

/** Rust's `{:?}` of a list of strings. */
const debug_list = (l: string[]) => `[${l.map((x) => JSON.stringify(x)).join(", ")}]`;

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
    let ds: number[] = [];
    for (const d of t.weekdays) {
      const w = weekday(d);
      if (w === null) throw bad(`weekdays must be from ${debug_list(WEEKDAYS)}`);
      ds.push(w);
    }
    ds = [...new Set(ds)].sort((a, b) => a - b);
    const weekdays = ds.length === 7 ? [] : ds.map((d) => WEEKDAYS[d]);
    return { kind: "daily", time: `${pad(Math.floor(at / 60))}:${pad(at % 60)}`, weekdays };
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

/**
 * An action as it's stored: checked against the automation's project, so it can only make tasks
 * there, with its agent configs, and only message its tasks.
 */
export function check_action(c: Conn, project: Project, a: Action): Action {
  const blank = (v: string | null | undefined) => {
    const t = v?.trim();
    return t ? t : null;
  };
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
      { kind: "create_task", title: title.trim(), description, task_type, claude_config_id: claude_config_id ?? null, model: blank(model), effort, status, start },
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
  return null;
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
