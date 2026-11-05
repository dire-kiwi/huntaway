// Port of server/src/integrations/automations.rs.
/**
 * Automations: a project's tasks created (or messages sent to one of its tasks) on a schedule or
 * when a webhook is delivered, so recurring work and outside events land on the board by themselves.
 *
 * **Triggers.** An interval (`every_minutes`, from when it's turned on), a time of day on some
 * weekdays in the host's time zone, or a webhook: `POST /api/hooks/<id>/<token>`, which is the
 * one route that doesn't take the board's token. It reaches nothing but its own automation: an
 * unknown id or a wrong token (compared in constant time) is the same 404, the payload only fills
 * in templates (it can't pick the project, the task, the agent config or anything else), and a
 * message goes only to a task in the automation's own project. Deliveries can be checked against
 * a secret (GitHub's `X-Hub-Signature-256`), filtered on their event, action, labels or any other
 * value (GitHub's `ping`, sent when a webhook is added, is ignored unless a filter asks for it),
 * are dropped when their `X-GitHub-Delivery` made a run in the last week, and can be
 * coalesced: those within a window (and with the same key) make one run, from the latest of them.
 * Bodies are at most `MAX_BODY`, and an automation takes at most `RATE_PER_MINUTE` deliveries a minute.
 *
 * **Actions.** Create a task from a template (title, description, type, agent config, model,
 * effort, status, and whether to start it), or send a message to a task. Templates take
 * `{{body.issue.title}}`-style values from a delivery (see `lookup`); in a description or
 * message each one is wrapped in `<untrusted-data>` tags, with a note telling the agent that
 * what's inside is data, not instructions.
 *
 * **Missed runs and restarts.** The scheduler (`tick`, every few seconds) claims a due run by
 * moving the automation's `next_run_at` on, and records it, in one transaction before it does
 * anything, so a restart can't run it twice. There's no backfill: an interval that came due while
 * the server was down runs once, late; a time of day more than `LATE_GRACE` late is skipped (and
 * recorded as missed). A run that was under way when the server stopped is marked as interrupted
 * on the next start, and isn't run again. Coalesced deliveries wait in the database, so they run
 * after a restart.
 *
 * Times (Rust's `DateTime<Utc>`) are milliseconds since the epoch here.
 */
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { new_id, now as util_now } from "../util.ts";

export * from "./automations/check.ts";
export * from "./automations/delivery.ts";
export * from "./automations/running.ts";
export * from "./automations/handlers.ts";

/** The shortest and longest intervals a schedule can have. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 31;
/** A time-of-day run this late (the server was down or asleep) is skipped rather than run. */
export const LATE_GRACE = 10 * 60_000;
/** How often the scheduler looks for runs that are due. */
export const TICK = 5_000;
/** The largest webhook body taken (a bigger one gets a 413). */
export const MAX_BODY = 1 << 20;
/** Deliveries an automation takes a minute; more get a 429. */
export const RATE_PER_MINUTE = 60;
/** Coalesced runs an automation can have waiting at once. */
export const MAX_PENDING = 20;
export const MAX_COALESCE_SECONDS = 3600;
/** How long a delivery's id is kept, so the same delivery sent again is dropped. */
export const DEDUPE_DAYS = 7;
export const MAX_FILTERS = 16;
/** Each value a template takes from a delivery, and the whole text it makes, are cut to these. */
export const MAX_VALUE_CHARS = 20_000;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_TITLE_CHARS = 200;
/**
 * Runs kept per automation: everything from the last DEDUPE_DAYS up to KEEP_RUNS, and at least
 * KEEP_RECENT; payloads only for the latest KEEP_PAYLOADS (for the next test delivery).
 */
export const KEEP_RUNS = 1000;
export const KEEP_RECENT = 50;
export const KEEP_PAYLOADS = 5;
/** Headers a delivery keeps (for templates and filters) leave these out. */
export const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-hub-signature", "x-hub-signature-256"];
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const UNTRUSTED_TAG = "untrusted-data";

const DAY = 86_400_000;

// ---------- what an automation is ----------

/**
 * `{"kind": "interval", every_minutes}`: every `every_minutes`, from when it's turned on (or its schedule changes).
 * `{"kind": "daily", time, weekdays}`: at `time` (`HH:MM`, in the host's time zone) on `weekdays` (`mon` … `sun`; none
 * is every day). `{"kind": "webhook", filters, coalesce_seconds, coalesce_key}`: each delivery to its URL that passes
 * its `filters`; deliveries in `coalesce_seconds` from the first make one run (0: each runs by itself), and with
 * coalescing, only deliveries whose key (a template, e.g. `{{body.issue.number}}`) is the same go together.
 */
export type Trigger =
  | { kind: "interval"; every_minutes: number }
  | { kind: "daily"; time: string; weekdays: string[] }
  | { kind: "webhook"; filters: Filter[]; coalesce_seconds: number; coalesce_key: string };

export type FilterOp = "equals" | "not_equals" | "starts_with" | "contains" | "in" | "not_in" | "exists" | "not_exists";
export const FILTER_OPS: FilterOp[] = ["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"];

/** A condition on a delivery (see `matches`). */
export interface Filter {
  /** What it looks at, as a template names it (see `lookup`), e.g. `event`, `action`, `labels` or `body.issue.user.login`. */
  path: string;
  op: FilterOp;
  /** A string, or for `in` and `not_in` a list (or a comma-separated string). */
  value: any;
}

/**
 * `create_task`: a task in the automation's project, from these templates and settings (`task_type` one of
 * db::TASK_TYPES, or null for a code task, or one of db::LABELS in an action stored before API 71; `labels` some of
 * db::LABELS, left out when empty; `status` `todo` or `backlog`; `start` starts its agent). `send_to_task`: a message
 * to a task in the automation's project.
 */
export type Action =
  | {
      kind: "create_task";
      title: string;
      description: string;
      task_type: string | null;
      labels?: string[];
      claude_config_id: string | null;
      model: string | null;
      effort: string | null;
      status: string;
      start: boolean;
    }
  | { kind: "send_to_task"; task_id: string; message: string };

export interface Automation {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  /** The secret part of its webhook URL. */
  token: string;
  /** Deliveries must be signed with it (`X-Hub-Signature-256`), if set. Never sent back. */
  secret: string | null;
  /** When its schedule next runs (UTC); none for a webhook, or while it's off. */
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

// serde's deserialization of the enums above, with its defaults (and errors much like its own).

const type_name = (v: any) =>
  v === null || v === undefined ? "null" : Array.isArray(v) ? "a sequence" : typeof v === "object" ? "a map" : typeof v === "string" ? `string ${JSON.stringify(v)}` : typeof v === "boolean" ? `boolean \`${v}\`` : `integer \`${v}\``;

function field(o: any, k: string, kind: "string" | "u32" | "bool" | "opt_string" | "string_list" | "any", def?: any): any {
  const v = o[k];
  if (v === undefined) {
    if (def !== undefined) return def;
    if (kind === "opt_string" || kind === "any") return kind === "any" ? null : null;
    throw new Error(`missing field \`${k}\``);
  }
  switch (kind) {
    case "string":
      if (typeof v !== "string") throw new Error(`invalid type: ${type_name(v)}, expected a string`);
      return v;
    case "opt_string":
      if (v !== null && typeof v !== "string") throw new Error(`invalid type: ${type_name(v)}, expected a string`);
      return v;
    case "u32":
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid type: ${type_name(v)}, expected u32`);
      if (!Number.isInteger(v)) throw new Error(`invalid type: floating point \`${v}\`, expected u32`);
      if (v < 0 || v > 0xffffffff) throw new Error(`invalid value: integer \`${v}\`, expected u32`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new Error(`invalid type: ${type_name(v)}, expected a boolean`);
      return v;
    case "string_list":
      if (!Array.isArray(v)) throw new Error(`invalid type: ${type_name(v)}, expected a sequence`);
      for (const x of v) if (typeof x !== "string") throw new Error(`invalid type: ${type_name(x)}, expected a string`);
      return [...v];
    case "any":
      return v;
  }
}

function object(v: any, what: string): any {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`invalid type: ${type_name(v)}, expected ${what}`);
  return v;
}

function kind_of<K extends string>(v: any, what: string, kinds: K[]): K {
  const o = object(v, `internally tagged enum ${what}`);
  if (o.kind === undefined) throw new Error("missing field `kind`");
  if (typeof o.kind !== "string") throw new Error(`invalid type: ${type_name(o.kind)}, expected variant identifier`);
  if (!kinds.includes(o.kind as K)) throw new Error(`unknown variant \`${o.kind}\`, expected one of ${kinds.map((k) => `\`${k}\``).join(", ")}`);
  return o.kind as K;
}

/** A Trigger from its JSON, as serde reads it. Throws serde's sort of error. */
export function Trigger_from_json(v: any): Trigger {
  const kind = kind_of(v, "Trigger", ["interval", "daily", "webhook"]);
  if (kind === "interval") return { kind, every_minutes: field(v, "every_minutes", "u32") };
  if (kind === "daily") return { kind, time: field(v, "time", "string"), weekdays: field(v, "weekdays", "string_list", []) };
  const filters = field(v, "filters", "any", []);
  if (!Array.isArray(filters)) throw new Error(`invalid type: ${type_name(filters)}, expected a sequence`);
  return {
    kind,
    filters: filters.map(Filter_from_json),
    coalesce_seconds: field(v, "coalesce_seconds", "u32", 0),
    coalesce_key: field(v, "coalesce_key", "string", ""),
  };
}

function Filter_from_json(v: any): Filter {
  const o = object(v, "struct Filter");
  const path = field(o, "path", "string");
  const op = field(o, "op", "any");
  if (op === null) throw new Error("missing field `op`");
  if (typeof op !== "string") throw new Error(`invalid type: ${type_name(op)}, expected variant identifier`);
  if (!FILTER_OPS.includes(op as FilterOp)) throw new Error(`unknown variant \`${op}\`, expected one of ${FILTER_OPS.map((k) => `\`${k}\``).join(", ")}`);
  return { path, op: op as FilterOp, value: o.value === undefined ? null : o.value };
}

/** An Action from its JSON, as serde reads it. Throws serde's sort of error. */
export function Action_from_json(v: any): Action {
  const kind = kind_of(v, "Action", ["create_task", "send_to_task"]);
  if (kind === "send_to_task") return { kind, task_id: field(v, "task_id", "string"), message: field(v, "message", "string") };
  const a = {
    kind: "create_task" as const,
    title: field(v, "title", "string"),
    description: field(v, "description", "string", ""),
    task_type: field(v, "task_type", "opt_string"),
    claude_config_id: field(v, "claude_config_id", "opt_string"),
    model: field(v, "model", "opt_string"),
    effort: field(v, "effort", "opt_string"),
    status: field(v, "status", "string", "todo"),
    start: field(v, "start", "bool", false),
  };
  const labels: string[] = field(v, "labels", "string_list", []);
  return set_labels(a, labels);
}

/** `a` with `labels` (serde leaves an empty list out), in serde's field order. */
export function set_labels(a: Extract<Action, { kind: "create_task" }>, labels: string[]): Action {
  const { kind, title, description, task_type, claude_config_id, model, effort, status, start } = a;
  return labels.length
    ? { kind, title, description, task_type, labels, claude_config_id, model, effort, status, start }
    : { kind, title, description, task_type, claude_config_id, model, effort, status, start };
}

/** A JSON value with its objects' keys sorted (serde_json's `Value` keeps them sorted), as text. */
export function sorted_json(v: any): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
}

export function Automation_from_row(r: any): Automation {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    enabled: !!r.enabled,
    trigger: Trigger_from_json(JSON.parse(r.trigger)),
    action: Action_from_json(JSON.parse(r.action)),
    token: r.token,
    secret: r.secret ?? null,
    next_run_at: r.next_run_at ?? null,
    last_run_at: r.last_run_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function is_webhook(a: Automation): boolean {
  return a.trigger.kind === "webhook";
}

/** Where deliveries go, on this host. */
export function hook_path(a: Automation): string {
  return `/api/hooks/${a.id}/${a.token}`;
}

/** A run, or a webhook delivery that didn't make one. */
export interface Run {
  id: string;
  automation_id: string;
  /** `schedule`, `webhook` or `manual` (Run now, or a test delivery). */
  source: string;
  /**
   * `pending` (waiting to coalesce), `coalesced` (into `batch_id`), `running`, `ok`, `failed`,
   * `skipped` (missed, the automation was off, or too many coalesced runs were waiting), `filtered` (or an ignored
   * ping), `duplicate` or `rejected` (a bad signature).
   */
  status: string;
  detail: string | null;
  /** The task it created or messaged. */
  task_id: string | null;
  delivery_id: string | null;
  /** A delivery's event, e.g. `issues.opened`. */
  event: string | null;
  /** Deliveries in it (coalesced ones count). */
  count: number;
  batch_id: string | null;
  /** Not serialized (a hidden property, see db.hidden). */
  batch_key?: string | null;
  /** Not serialized (a hidden property, see db.hidden). */
  payload?: string | null;
  /** When it was due: a scheduled run's time, or when a coalesced one runs. */
  due_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export function Run_from_row(r: any): Run {
  const run: Run = {
    id: r.id,
    automation_id: r.automation_id,
    source: r.source,
    status: r.status,
    detail: r.detail ?? null,
    task_id: r.task_id ?? null,
    delivery_id: r.delivery_id ?? null,
    event: r.event ?? null,
    count: Number(r.count),
    batch_id: r.batch_id ?? null,
    due_at: r.due_at ?? null,
    created_at: r.created_at,
    finished_at: r.finished_at ?? null,
  };
  db.hidden(run, "batch_key", r.batch_key ?? null);
  db.hidden(run, "payload", r.payload ?? null);
  return run;
}

export function Run_new(automation_id: string, source: string, status: string, now: number): Run {
  const run: Run = {
    id: new_id(),
    automation_id,
    source,
    status,
    detail: null,
    task_id: null,
    delivery_id: null,
    event: null,
    count: 1,
    batch_id: null,
    due_at: null,
    created_at: fmt(now),
    finished_at: null,
  };
  db.hidden(run, "batch_key", null);
  db.hidden(run, "payload", null);
  return run;
}

/** Times are stored as UTC RFC 3339 with milliseconds (as util::now), so they sort as strings. */
export function fmt(t: number): string {
  return new Date(t).toISOString();
}

export function parse_time(s: string | null | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export const days = (n: number) => n * DAY;

// ---------- the database ----------

export function get(c: Conn, id: string): Automation | null {
  const r = db.one(c, "SELECT * FROM automations WHERE id=?1", id);
  return r ? Automation_from_row(r) : null;
}

export function list(c: Conn, project_id: string): Automation[] {
  return db.all(c, "SELECT * FROM automations WHERE project_id=?1 ORDER BY created_at, id", project_id).map(Automation_from_row);
}

export function insert_run(c: Conn, r: Run): void {
  db.run(
    c,
    `INSERT INTO automation_runs (id,automation_id,source,status,detail,task_id,delivery_id,event,count,batch_key,batch_id,payload,due_at,created_at,finished_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
    r.id, r.automation_id, r.source, r.status, r.detail, r.task_id, r.delivery_id, r.event, r.count, r.batch_key ?? null, r.batch_id, r.payload ?? null,
    r.due_at, r.created_at, r.finished_at,
  );
}

export function get_run(c: Conn, id: string): Run | null {
  const r = db.one(c, "SELECT * FROM automation_runs WHERE id=?1", id);
  return r ? Run_from_row(r) : null;
}

/** An automation's latest runs, newest first. */
export function runs(c: Conn, automation_id: string, limit: number): Run[] {
  return db.all(c, "SELECT * FROM automation_runs WHERE automation_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2", automation_id, limit).map(Run_from_row);
}

/** How a run went: the task it made or messaged, or why it failed (with the task, if it made one). */
export type RunResult = { ok: string | null } | { err: [string | null, string] };

/** Ends a run: what it did, or why it didn't. */
export function finish(c: Conn, run_id: string, result: RunResult): void {
  const [status, task, detail] = "ok" in result ? ["ok", result.ok, null] : ["failed", result.err[0], result.err[1]];
  db.run(
    c,
    "UPDATE automation_runs SET status=?2, task_id=COALESCE(?3, task_id), detail=?4, finished_at=?5 WHERE id=?1",
    run_id, status, task, detail, util_now(),
  );
}

/** Runs left `running` by a server that stopped: they may or may not have made their task, so they aren't run again. */
export function mark_interrupted(c: Conn): number {
  return db.run(
    c,
    `UPDATE automation_runs SET status='failed', finished_at=?1,
           detail='Interrupted: the server stopped while this ran, so it may or may not have taken effect. It is not run again.'
         WHERE status='running'`,
    util_now(),
  ).changes;
}

/** Drops old runs (see KEEP_RUNS) and payloads. */
export function prune(c: Conn, now: number): void {
  const cutoff = fmt(now - days(DEDUPE_DAYS));
  const ids = db.all(c, "SELECT id FROM automations").map((r: any) => r.id as string);
  for (const id of ids) {
    const newest = "SELECT id FROM automation_runs WHERE automation_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2";
    db.run(c, `DELETE FROM automation_runs WHERE automation_id=?1 AND status NOT IN ('pending','running') AND id NOT IN (${newest})`, id, KEEP_RUNS);
    db.run(
      c,
      `DELETE FROM automation_runs WHERE automation_id=?1 AND status NOT IN ('pending','running') AND created_at < ?3 AND id NOT IN (${newest})`,
      id, KEEP_RECENT, cutoff,
    );
    db.run(
      c,
      `UPDATE automation_runs SET payload=NULL WHERE automation_id=?1 AND payload IS NOT NULL AND status NOT IN ('pending','running') AND id NOT IN
               (SELECT id FROM automation_runs WHERE automation_id=?1 AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
      id, KEEP_PAYLOADS,
    );
  }
}

export function changed(s: Shared, a: Automation): void {
  s.emit({ type: "automations_changed", project_id: a.project_id, automation_id: a.id });
}

/** `ApiError::bad`. */
export function bad(m: string): ApiError {
  return ApiError.bad(m);
}
