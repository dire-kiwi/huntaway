// Port of server/src/mcp/tools/tasks.rs: what the task tools return (a task's details, fields and summary) and some of
// what they take (marks, reminders).
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as focus from "../../agent/focus.ts";
import * as documents from "../../agent/documents.ts";
import { path_str } from "../../util.ts";
import { ToolError, type Ctx } from "../tools.ts";
import { TASK_FIELD_DEFAULT_LIMIT, TASK_FIELD_MAX_LIMIT } from "./dispatch.ts";
import { boards, project_key } from "./resolve.ts";

/** Unicode characters (Rust's `chars()`). */
const chars = (s: string) => Array.from(s);
const char_count = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/**
 * The fields offered to agents, shared by the overview and paginated reads. Do not serialize the database Task here: it
 * includes fields the tools don't expose (including private links).
 */
export function task_details(s: Shared, ctx: Ctx, t: Task): any {
  const out = summarize(s, t);
  out.description = t.description;
  out.worktree_path = t.worktree_path ?? null;
  out.last_message = db.last_assistant_text(s.db(), t.id) ?? null;
  // A task can create tasks on boards the caller cannot use (or no longer can use).
  const readable = boards(s, ctx);
  const created = db.created_tasks(s.db(), t.id).filter((c) => readable.some((b) => b.id === c.profile_id));
  if (created.length) out.created_tasks = created.map((c) => summary(s, c));
  return out;
}

/** Pretty JSON as serde_json writes it: keys sorted, two-space indents. */
function pretty(v: any): string {
  return JSON.stringify(sorted(v), null, 2);
}

function sorted(v: any): any {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sorted(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}

/** Strings are read as plain text; everything else is read as pretty JSON, including null. */
function field_text(value: any): string {
  return typeof value === "string" ? value : pretty(value);
}

export function task_overview(details: any): any {
  const out: Record<string, any> = {};
  const lengths: Record<string, number> = {};
  const omitted: string[] = [];
  // Bound both each value and the whole response, even if several metadata fields grow. Count serialized bytes too:
  // escapes and nested JSON can be much larger than plain text.
  let budget = 6000;
  for (const name of Object.keys(details).sort()) {
    const value = details[name] ?? null;
    lengths[name] = char_count(field_text(value));
    const size = Buffer.byteLength(pretty(value));
    if (size <= 1000 && size <= budget) {
      budget -= size;
      out[name] = value;
    } else omitted.push(name);
  }
  out.field_lengths = lengths;
  out.omitted_fields = omitted;
  return out;
}

export function task_field(details: any, args: any): any {
  const field = typeof args?.field === "string" ? args.field : "";
  if (!Object.hasOwn(details, field)) {
    throw ToolError.other(
      `unknown task field ${JSON.stringify(field)}; available fields: ${Object.keys(details).sort().join(", ")} (see get_task's field_lengths)`,
    );
  }
  const value = details[field] ?? null;
  const number = (name: string, def: number): number => {
    if (!args || !Object.hasOwn(args, name)) return def;
    const v = args[name];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
    throw ToolError.other(`${name} must be a non-negative integer`);
  };
  const offset = number("offset", 0);
  const limit = number("limit", TASK_FIELD_DEFAULT_LIMIT);
  if (limit === 0 || limit > TASK_FIELD_MAX_LIMIT) throw ToolError.other(`limit must be between 1 and ${TASK_FIELD_MAX_LIMIT}`);
  const text = chars(field_text(value));
  const total_length = text.length;
  const content = offset >= total_length ? "" : text.slice(offset, offset + limit).join("");
  const length = char_count(content);
  const next = offset + length;
  return {
    task_id: details.id ?? null,
    field,
    format: typeof value === "string" ? "text" : "json",
    offset,
    limit,
    length,
    total_length,
    next_offset: next < total_length ? next : null,
    content,
  };
}

export function summarize(s: Shared, t: Task): any {
  const v = summary(s, t);
  if (t.depends_on.length) {
    const key = project_key(s, t);
    const deps = t.depends_on
      .map((id) => {
        try {
          return db.get_task(s.db(), id);
        } catch {
          return null;
        }
      })
      // Only ever in its own project (and so on its board); anything else is left out.
      .filter((d): d is Task => !!d && d.project_id !== null && d.project_id === t.project_id)
      .map((d) => ({ key: `${key}-${d.number}`, title: d.title, status: d.status, merged: db.is_merged(d) }));
    if (deps.length) v.depends_on = deps;
  }
  if (t.start_from) {
    const key = project_key(s, t);
    v.start_from = db.describe(t.start_from, s.db(), key);
    // Where that took it, once its worktree is made: what its pull request targets.
    if (t.branch != null) v.base_branch = t.base_branch ?? null;
  }
  if (t.waiting) v.queued_for_dependencies = true;
  if (t.subproject) v.is_subproject = true;
  if (t.project_id === null && t.group_name != null) v.group_task = t.group_name;
  // Its labels, and where the plan, artifact or diagram each asks for is, for agents on this host to read.
  const docs: Array<[string, string]> = documents.paths(s, t);
  if (docs.length) {
    v.labels = docs.map(([l]) => l);
    const files: Record<string, string> = {};
    for (const [l, f] of docs) files[l] = path_str(f);
    v.documents = files;
  }
  if (db.is_scratch(t)) v.type = db.SCRATCH;
  if (t.parent_id && t.kind === "task") {
    let sp: Task | null = null;
    try {
      sp = db.get_task(s.db(), t.parent_id);
    } catch {}
    if (sp) v.subproject = `${project_key(s, sp)}-${sp.number}`;
  }
  return v;
}

/**
 * The star and reminder `create_task` gives the new task, checked in full before the task is created (and its agent
 * started), so a call that fails leaves no task behind for a retry to duplicate.
 */
export function new_task_marks(args: any): Array<[string, any]> {
  const given = reminder_args(args);
  const marks: Array<[string, any]> = api.MARK_FIELDS.filter((k: string) => Object.hasOwn(given, k)).map((k: string) => [k, given[k]] as [string, any]);
  api.check_reminder(null, marks);
  return marks;
}

/** Task `t`, just made by `create_task`, with who made it and the star and reminder it was given. */
export function created(s: Shared, ctx: Ctx, t: Task, marks: Array<[string, any]>): Task {
  // Kept so a group task (or any task) can show how the tasks it created are doing.
  const own = ctx.task;
  if (own && own.kind === "task") t = s.update_task(t.id, [["created_by", own.id]]) ?? t;
  if (marks.length) t = s.update_task(t.id, marks) ?? t;
  return t;
}

/** Task `t`, just made by `create_task`, in "now" like every task made from the board, unless the caller said `now: false`. */
export function new_in_now(s: Shared, args: any, t: Task): Task {
  return args.now === false ? t : (focus.put_in_now(s, t.id) ?? t);
}

/**
 * `starred`, `remind_at`, `reminder` and (on update_task) `now` from `create_task` or `update_task`, with the time made
 * absolute (see reminder_time). The API checks the rest.
 */
export function reminder_args(args: any): Record<string, any> {
  const body: Record<string, any> = {};
  for (const k of ["starred", "reminder", "now"]) if (args[k] != null) body[k] = args[k];
  const at = args.remind_at;
  if (typeof at === "string") {
    const t = reminder_time(at, new Date());
    if (t === null) {
      throw ToolError.other(
        "remind_at must be a delay like 30m, 2h, 3d or 1w, a time like 2026-05-01T09:00:00Z (or 2026-05-01 09:00 in the host's time zone), " +
          "or an empty string to clear the reminder",
      );
    }
    body.remind_at = t;
  } else if (at != null) body.remind_at = at;
  return body;
}

/** Whether `v` is an RFC 3339 time (chrono's `DateTime::parse_from_rfc3339`). */
function is_rfc3339(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) return false;
  const [mo, d, h, mi, se] = [+m[2], +m[3], +m[4], +m[5], +m[6]];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && se <= 60 && !isNaN(Date.parse(v.replace(/ /, "T")));
}

/** A time to the millisecond with a Z (chrono's `to_rfc3339_opts(Millis, true)`). */
const rfc3339_millis = (d: Date) => d.toISOString();

/**
 * A reminder's time as RFC 3339, from what an agent passes: a delay from `now` (`30m`, `2h`, `1d 12h`, `in 3 days`, `1w`),
 * an RFC 3339 time, or a date and time (or just a date, at 9:00) in the host's time zone. Blank clears the reminder. Null
 * if it's none of those.
 */
export function reminder_time(v: string, now: Date): string | null {
  v = v.trim();
  if (!v) return "";
  if (is_rfc3339(v)) return v;
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (local) {
    const [y, mo, d] = [+local[1], +local[2], +local[3]];
    const [h, mi, se] = local[4] === undefined ? [9, 0, 0] : [+local[4], +local[5], local[6] === undefined ? 0 : +local[6]];
    const t = new Date(y, mo - 1, d, h, mi, se);
    // A date or time that doesn't exist (2026-02-30, 25:00) isn't one.
    if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || h > 23 || mi > 59 || se > 59) return null;
    return rfc3339_millis(t);
  }
  // A delay: numbers each followed by a unit, e.g. "1h30m" or "in 2 days".
  const rest = (v.startsWith("in ") ? v.slice(3) : v).toLowerCase();
  const cs = Array.from(rest).filter((c) => !/\s/.test(c) && c !== ",");
  let i = 0;
  let total = 0;
  let any = false;
  while (i < cs.length) {
    let n = "";
    while (i < cs.length && /[0-9]/.test(cs[i])) n += cs[i++];
    let unit = "";
    while (i < cs.length && /[a-z]/i.test(cs[i])) unit += cs[i++];
    if (!n) return null;
    const num = Number(n);
    if (num > 10_000) return null;
    const minute = 60_000;
    if (["m", "min", "mins", "minute", "minutes"].includes(unit)) total += num * minute;
    else if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) total += num * 60 * minute;
    else if (["d", "day", "days"].includes(unit)) total += num * 24 * 60 * minute;
    else if (["w", "wk", "week", "weeks"].includes(unit)) total += num * 7 * 24 * 60 * minute;
    else return null;
    any = true;
  }
  return any ? rfc3339_millis(new Date(now.getTime() + total)) : null;
}

export function summary(s: Shared, t: Task): any {
  let profile: string | null = null;
  try {
    profile = db.get_profile(s.db(), t.profile_id)?.name ?? null;
  } catch {}
  const v: any = {
    id: t.id,
    key: `${project_key(s, t)}-${t.number}`,
    title: t.title,
    status: t.status,
    resolution: t.resolution ?? null,
    running: t.running,
    attention_reason: t.attention_reason ?? null,
    branch: t.branch ?? null,
    preview_url: t.preview_url ?? null,
    pr_url: t.pr_url ?? null,
    review: t.review ? { state: t.review.state, summary: t.review.summary ?? null, issues: t.review.issues } : null,
    project_id: t.project_id ?? null,
    profile,
    host: s.host_name,
  };
  if (t.external_links.length) v.external_links = t.external_links;
  if (t.starred) v.starred = true;
  if (t.remind_at != null) {
    v.remind_at = t.remind_at;
    v.reminder = t.reminder ?? null;
  }
  if (t.now_at != null) v.now = true;
  return v;
}
