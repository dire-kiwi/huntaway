// Port of server/src/db.rs: the board's SQLite database. `open` (db/schema.ts) creates or migrates it, and the other
// parts have the rows and queries of each table. Host-wide settings, and the values task fields can take, are here.
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { ApiError } from "./http.ts";

export type Conn = DatabaseSync;

/** A parameter as node:sqlite takes it: booleans as 0/1, undefined as NULL, objects and arrays as their JSON. */
function param(v: any): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

const params = (ps: any[]) => ps.map(param);

/**
 * Each connection's prepared statements, by their SQL, so a query that runs again isn't parsed and planned again (HA-183:
 * a token report ran 10,000 small queries, and spent half its time preparing them). The latest MAX_STATEMENTS are kept,
 * as some SQL is made up per call (lists of values, the columns an update sets).
 */
const statements = new WeakMap<Conn, Map<string, StatementSync>>();
const MAX_STATEMENTS = 500;

/** `sql` prepared on `c`, from the cache when it has it (`arrays`: one that returns rows as arrays, for `value`). */
export function prepared(c: Conn, sql: string, arrays = false): StatementSync {
  let cache = statements.get(c);
  if (!cache) statements.set(c, (cache = new Map()));
  const key = arrays ? `[]${sql}` : sql;
  let st = cache.get(key);
  if (st) {
    // Most recently used last, so the first is the one to drop.
    cache.delete(key);
  } else {
    st = c.prepare(sql);
    if (arrays) st.setReturnArrays(true);
    if (cache.size >= MAX_STATEMENTS) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, st);
  return st;
}

/** The first row, or undefined (rusqlite's `query_row(…).optional()`). */
export function one<T = any>(c: Conn, sql: string, ...ps: any[]): T | undefined {
  return prepared(c, sql).get(...params(ps)) as T | undefined;
}

/** Every row. */
export function all<T = any>(c: Conn, sql: string, ...ps: any[]): T[] {
  return prepared(c, sql).all(...params(ps)) as T[];
}

/** Run a statement: how many rows it changed, and the last inserted rowid. */
export function run(c: Conn, sql: string, ...ps: any[]): { changes: number; lastInsertRowid: number } {
  const r = prepared(c, sql).run(...params(ps));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** The first column of the first row, or undefined. */
export function value<T = any>(c: Conn, sql: string, ...ps: any[]): T | undefined {
  const row = prepared(c, sql, true).get(...params(ps)) as any[] | undefined;
  return row?.[0] as T | undefined;
}

/**
 * Run `f` in a transaction, committed if it returns and rolled back if it throws. Nested calls use savepoints.
 * `immediate` takes the database's write lock at the start (BEGIN IMMEDIATE), for a process writing beside a running
 * server: a deferred transaction that reads first can't take it later once the server has written meanwhile.
 */
let depth = 0;
export function tx<T>(c: Conn, f: () => T, immediate = false): T {
  const top = depth === 0;
  const sp = `sp${depth}`;
  c.exec(top ? (immediate ? "BEGIN IMMEDIATE" : "BEGIN") : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const out = f();
    c.exec(top ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    // A COMMIT that failed (a deferred foreign key) leaves the transaction open, and some errors end it themselves.
    if (!top) c.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    else if (c.isTransaction) c.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}


export * from "./db/links.ts";
export * from "./db/messages.ts";
export * from "./db/profiles.ts";
export * from "./db/projects.ts";
export * from "./db/runs.ts";
export * from "./db/schema.ts";
export * from "./db/task_data.ts";
export * from "./db/tasks.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** A thread's own effort can also be one only Codex models have (API 25). */
export const THREAD_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Host-wide settings (agent defaults). */
export function get_setting(c: Conn, key: string): string | null {
  return value<string>(c, "SELECT value FROM settings WHERE key=?1", key) ?? null;
}

export function set_setting(c: Conn, key: string, v: string | null | undefined): void {
  if (v != null && v.trim() !== "") {
    run(c, "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2", key, v.trim());
  } else {
    run(c, "DELETE FROM settings WHERE key=?1", key);
  }
}

export const STATUSES = ["todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done", "backlog"];
/** The task type of a scratch task. */
export const SCRATCH = "scratch";
/** What a task can be besides a code task: `scratch`, for a scratch task (see is_scratch). */
export const TASK_TYPES = [SCRATCH];
/**
 * The task type of a profile's assistant (see is_assistant). Not one of TASK_TYPES: it's made by the board, one per
 * profile (see agent/assistant.ts), not asked for as a new task's type.
 */
export const ASSISTANT = "assistant";
/**
 * The task type of a routine's run of the assistant (see is_routine): a thread under the assistant (`parent_id`), made
 * by a routine (see integrations/automations.ts), off the board.
 */
export const ROUTINE = "routine";
/**
 * The labels a task can have, each a document its agent writes besides its other work (see Task.labels and
 * agent/documents.rs), in the order the task shows them. They were task types of their own before API 71, which still
 * accepts them as a new task's `task_type`.
 */
export const LABELS = ["plan", "artifact", "diagram"];
/**
 * What a new task's type can also be, to make it a subproject (API 51). It's kept as Task.subproject rather than in
 * `task_type`, which is for tasks with no worktree.
 */
export const SUBPROJECT = "subproject";
/** How a task in "Done" ended. Only done tasks have one (see update_task). */
export const RESOLUTIONS = ["done", "not_done", "wont_fix"];

/** Rust's `{:?}` of a list of strings. */
const debug_list = (l: string[]) => `[${l.map((x) => JSON.stringify(x)).join(", ")}]`;

/**
 * Check a requested resolution for a task that has (or is moving to) `status`. Null asks for the default.
 * Rust's `Err(String)` is an `ApiError.bad` thrown (every caller turns it into one).
 */
export function check_resolution(status: string, resolution: any): void {
  if (resolution == null) return;
  if (!(typeof resolution === "string" && RESOLUTIONS.includes(resolution))) {
    throw ApiError.bad(`resolution must be null or one of ${debug_list(RESOLUTIONS)}`);
  }
  if (status !== "done") throw ApiError.bad("resolution can only be set on a done task");
}

export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];

/** The agent CLIs a config can be for: Claude Code (`claude -p`) and Codex (`codex app-server`, see agent/codex.rs). */
export const AGENTS = ["claude", "codex"];

/** A JSON list of strings, or an empty list if it isn't one. */
export function json_list(v: string | null | undefined): string[] {
  const l = json_or_default<any>(v, null);
  return Array.isArray(l) && l.every((x) => typeof x === "string") ? l : [];
}

/** A JSON column's value, or `def` if it's null or not JSON (or `check`, if given, throws on it). */
export function json_or_default<T>(v: string | null | undefined, def: T, check?: (x: any) => T): T {
  if (v == null) return def;
  try {
    const x = JSON.parse(v);
    return check ? check(x) : x;
  } catch {
    return def;
  }
}

/** `UPDATE table SET col=?… WHERE id=?` for whitelisted columns. */
export function update_generic(c: Conn, table: string, allowed: string[], id: string, fields: Array<[string, any]>): void {
  if (!fields.length) return;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [col, v] of fields) {
    if (!allowed.includes(col)) throw new Error(`unknown column ${col}`);
    vals.push(json_to_sql(v));
    sets.push(`${col}=?${vals.length}`);
  }
  vals.push(id);
  run(c, `UPDATE ${table} SET ${sets.join(",")} WHERE id=?${vals.length}`, ...vals);
}

/** A JSON value as SQLite stores it: null, booleans as 0/1, numbers, strings, and anything else as its JSON. */
export function json_to_sql(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Sets a field serde doesn't serialize (`#[serde(skip)]`, `skip_serializing`) on a row: a non-enumerable property, so
 * `JSON.stringify` leaves it out (as do spreads and `Object.keys`: copy it by name if a copy needs it).
 */
export function hidden<T extends object>(o: T, k: string, v: any): T {
  Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false });
  return o;
}
