// `huntaway threads-import --db <file> [--json] [--task <id or key>]... [--examples <n>] [--write <new file>]`: a dry run
// of the translator (threads/translate.ts) over a board's tasks. It opens the database read-only and changes nothing in
// it (no import, no migration), so it can run on a copy of the live board (scripts/copy-live-board.sh makes a scrubbed
// one). It reports how each task's messages translate, and in total: what each message became, the warnings, which
// tasks couldn't be switched over now, how long it took and how big the items and events are.
//
// With `--write`, it also writes every task's thread into a new database file of its own (made at this build's schema,
// with no tasks, so without foreign keys), one message at a time with threads/store.ts as the live path will, to measure
// what the tables would take on disk and how long writing them does.
//
// The port of HA-128's server/src/threads/report.rs.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { FILE, OLDER } from "../db/file.ts";
import * as store from "./store.ts";
import type { Item, NewEvent, ThreadRequest } from "./protocol.ts";
import { CONVERTER_VERSION, Translator, fold, type Disposition, type ItemMeta, type Warning } from "./translate.ts";

/** Why a task couldn't be switched over to items now. */
function blockers(c: Conn, task: db.Task): string[] {
  const out: string[] = [];
  if (task.running) out.push("running");
  // A run's process can be alive between turns.
  if (db.has_active_run(c, task.id)) out.push("active_run");
  if (task.queued_message?.trim() || task.steering.length) out.push("queued_input");
  if (task.merging) out.push("merging");
  const prompts = db.value<number>(
    c,
    `SELECT EXISTS(SELECT 1 FROM permission_requests WHERE task_id=?1 AND status='pending')
       OR EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.status')='pending')`,
    task.id,
  );
  if (prompts) out.push("open_prompt");
  return out;
}

export interface TaskReport {
  task_id: string;
  key: string;
  harness: string;
  messages: number;
  /** The source messages' data, for comparison. */
  message_bytes: number;
  events: number;
  /** The events' size as JSON, as thread_events keeps them (numbered). */
  event_bytes: number;
  /** Of those, the last store.KEEP_EVENTS': what a thread's log keeps once its events are a day old. */
  kept_event_bytes: number;
  items: Record<string, number>;
  /** The items' size as JSON, with their metas. */
  item_bytes: number;
  requests: number;
  request_bytes: number;
  /** thread_item_origins rows: each item's messages. */
  origins: number;
  rows: Record<Disposition, number>;
  warnings: Warning[];
  blockers: string[];
  /** How long translating it took. */
  ms: number;
  /** Why it didn't translate, if it didn't. */
  error: string | null;
}

/** Every task's id and key (`<project key>-<number>`, or the id for a task with no project), oldest first. */
function task_keys(c: Conn): Array<{ id: string; key: string }> {
  return db.all(
    c,
    "SELECT t.id AS id, COALESCE(p.key || '-' || t.number, t.id) AS key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.created_at, t.id",
  );
}

/** A task's messages, in id order, with their data's size as stored. */
function messages(c: Conn, task_id: string): Array<{ m: db.Message; bytes: number }> {
  return db.all<any>(c, "SELECT id, task_id, kind, data, created_at FROM messages WHERE task_id=?1 ORDER BY id", task_id).map((r) => ({
    m: db.Message_from_row(r),
    bytes: Buffer.byteLength(r.data ?? ""),
  }));
}

/** What translating a task gives: each message's events (the last group, with no message, `finish`'s), and the metas. */
interface Translated {
  steps: Array<{ message_id: number | undefined; events: NewEvent[] }>;
  meta: Map<string, ItemMeta>;
  items: Item[];
  requests: ThreadRequest[];
}

/** The report for `task`, and its translation if it translated. */
export function task_report(c: Conn, task: db.Task, key: string): { report: TaskReport; translated: Translated | null } {
  const rows = messages(c, task.id);
  const report: TaskReport = {
    task_id: task.id,
    key,
    harness: db.task_is_codex(c, task) ? "codex" : "claude",
    messages: rows.length,
    message_bytes: rows.reduce((n, r) => n + r.bytes, 0),
    events: 0,
    event_bytes: 0,
    kept_event_bytes: 0,
    items: {},
    item_bytes: 0,
    requests: 0,
    request_bytes: 0,
    origins: 0,
    rows: { converted: 0, redundant: 0, retained: 0 },
    warnings: [],
    blockers: blockers(c, task),
    ms: 0,
    error: null,
  };
  const started = performance.now();
  try {
    const t = new Translator();
    const steps: Translated["steps"] = [];
    const meta = new Map<string, ItemMeta>();
    const disposition = new Map<number, Disposition>();
    const origins = new Set<string>();
    for (const { m } of rows) {
      const s = t.message(m);
      steps.push({ message_id: m.id, events: s.events });
      disposition.set(m.id, s.disposition);
      report.warnings.push(...s.warnings);
      for (const [k, v] of s.meta) meta.set(k, v);
      for (const e of s.events) {
        const id = e.type === "item.added" ? e.item.id : e.type === "item.updated" ? e.item_id : null;
        if (id !== null) origins.add(`${id}\n${m.id}`);
      }
    }
    const f = t.finish();
    steps.push({ message_id: undefined, events: f.events });
    report.warnings.push(...f.warnings);
    for (const [k, v] of f.meta) meta.set(k, v);
    for (const id of f.retained) disposition.set(id, "retained");
    for (const d of disposition.values()) report.rows[d]++;
    const state = fold(steps.flatMap((s) => s.events));
    report.ms = performance.now() - started;
    // Sizes as the store keeps them: events numbered, items and requests as JSON, metas beside the items.
    const sizes: number[] = [];
    let seq = 0;
    for (const s of steps) {
      for (const e of s.events) {
        const numbered = { thread_id: task.id, seq: ++seq };
        sizes.push(Buffer.byteLength(JSON.stringify(Object.assign({ type: e.type, ...numbered }, e, numbered))));
      }
    }
    report.events = sizes.length;
    report.event_bytes = sizes.reduce((n, b) => n + b, 0);
    report.kept_event_bytes = sizes.slice(-store.KEEP_EVENTS).reduce((n, b) => n + b, 0);
    for (const item of state.items) {
      report.items[item.type] = (report.items[item.type] ?? 0) + 1;
      report.item_bytes += Buffer.byteLength(JSON.stringify(item));
      const m = meta.get(item.id);
      if (m) report.item_bytes += Buffer.byteLength(JSON.stringify(m));
    }
    report.requests = state.requests.length;
    report.request_bytes = state.requests.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
    report.origins = origins.size;
    return { report, translated: { steps, meta, ...state } };
  } catch (e: any) {
    // A throw is a bug in the translator: report it with the task, and go on with the others.
    report.error = e?.stack ?? String(e);
    report.ms = performance.now() - started;
    return { report, translated: null };
  }
}

/** The database file at `path`: a file, or a data dir's (the newest name it has). */
export function db_file(path: string): string {
  if (!statSync(path).isDirectory()) return path;
  for (const name of [FILE, ...OLDER]) if (existsSync(join(path, name))) return join(path, name);
  throw new Error(`no database in ${path}`);
}

/** Opens `path` read-only, at the version this build reads. */
export function open(path: string): Conn {
  const file = db_file(path);
  const c = new DatabaseSync(file, { readOnly: true });
  c.exec("PRAGMA busy_timeout=5000;");
  const version = db.value<number>(c, "PRAGMA user_version") ?? 0;
  if (version !== db.VERSION) {
    c.close();
    throw new Error(
      `${file} is at database version ${version}, and this build reads version ${db.VERSION}: run it on a copy that this build has opened (a test server's, say: scripts/copy-live-board.sh)`,
    );
  }
  return c;
}

export interface Options {
  json: boolean;
  /** Ids or keys; all tasks if none. */
  tasks: string[];
  examples: number;
  /** A new database file to write the threads to. */
  write: string | null;
}

export function parse_args(args: string[]): Options & { db: string } {
  const o: Options & { db: string } = { db: "", json: false, tasks: [], examples: 3, write: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--db") o.db = next();
    else if (a === "--json") o.json = true;
    else if (a === "--task") o.tasks.push(next());
    else if (a === "--examples") o.examples = Number(next());
    else if (a === "--write") o.write = next();
    else throw new Error(`unknown argument ${a}\nUsage: huntaway threads-import --db <file or data dir> [--json] [--task <id or key>]... [--examples <n>] [--write <new file>]`);
  }
  if (!o.db) throw new Error("--db <file or data dir> is needed");
  return o;
}

/** What writing the threads to a database of their own took. */
export interface Written {
  file: string;
  ms: number;
  bytes: number;
  /** By table (and its indexes), if the build's SQLite has dbstat. */
  tables: Record<string, number> | null;
}

/** Writes `t` for `task_id` to `out` as the live path will: each message's events in turn, then finish's, with the metas. */
function write_thread(out: Conn, task_id: string, t: Translated, at: string): void {
  db.tx(out, () => {
    for (const s of t.steps) store.append(out, task_id, s.events, { message_id: s.message_id, at });
    for (const [id, m] of t.meta) store.set_item_meta(out, task_id, id, m);
  });
}

export function run(o: Options & { db: string }, print: (s: string) => void = (s) => process.stdout.write(s)): TaskReport[] {
  const c = open(o.db);
  let out: Conn | null = null;
  if (o.write) {
    if (existsSync(o.write)) throw new Error(`${o.write} is there already: --write makes a new file`);
    out = db.open(o.write);
    // It has no tasks: the threads' rows go in without them.
    out.exec("PRAGMA foreign_keys=OFF;");
  }
  try {
    const keys = task_keys(c);
    const wanted = o.tasks.length
      ? o.tasks.map((id) => {
          const k = keys.find((k) => k.id === id || k.key.toLowerCase() === id.toLowerCase());
          if (!k) throw new Error(`no task ${id}`);
          return k;
        })
      : keys;
    const started = performance.now();
    let write_ms = 0;
    const at = new Date().toISOString();
    const reports: TaskReport[] = [];
    for (const { id, key } of wanted) {
      const task = db.get_task(c, id);
      if (!task) throw new Error(`no task ${id}`);
      const { report, translated } = task_report(c, task, key);
      if (out && translated) {
        const w = performance.now();
        try {
          write_thread(out, id, translated, at);
        } catch (e: any) {
          report.error = `writing: ${e?.stack ?? e}`;
        }
        write_ms += performance.now() - w;
      }
      reports.push(report);
    }
    const seconds = (performance.now() - started) / 1000;
    let written: Written | null = null;
    if (out && o.write) {
      out.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      written = { file: o.write, ms: write_ms, bytes: file_bytes(out), tables: table_bytes(out) };
    }
    if (o.json) print(JSON.stringify({ converter: CONVERTER_VERSION, seconds, written, tasks: reports }, null, 2) + "\n");
    else print(summary(reports, seconds, o.examples, written));
    return reports;
  } finally {
    c.close();
    out?.close();
  }
}

const file_bytes = (c: Conn) => (db.value<number>(c, "PRAGMA page_count") ?? 0) * (db.value<number>(c, "PRAGMA page_size") ?? 0);

function table_bytes(c: Conn): Record<string, number> | null {
  try {
    const rows = db.all<{ name: string; tbl: string; bytes: number }>(
      c,
      "SELECT s.name AS name, m.tbl_name AS tbl, SUM(s.pgsize) AS bytes FROM dbstat s JOIN sqlite_master m ON m.name = s.name GROUP BY s.name",
    );
    const out: Record<string, number> = {};
    for (const r of rows) if (r.tbl.startsWith("thread_")) out[r.tbl] = (out[r.tbl] ?? 0) + r.bytes;
    return out;
  } catch {
    return null;
  }
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The report as text: totals, then each warning's count with some examples. */
export function summary(reports: TaskReport[], seconds: number, examples: number, written: Written | null = null): string {
  const lines: string[] = [];
  const sum = (f: (r: TaskReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  const failed = reports.filter((r) => r.error !== null);
  lines.push(
    `${n(reports.length)} tasks, ${n(sum((r) => r.messages))} messages (${mb(sum((r) => r.message_bytes))}), translated in ${seconds.toFixed(1)}s ` +
      `(converter ${CONVERTER_VERSION}): ${n(failed.length)} failed.`,
  );
  const rows = (d: Disposition) => sum((r) => r.rows[d]);
  lines.push(`Messages: ${n(rows("converted"))} converted, ${n(rows("redundant"))} redundant, ${n(rows("retained"))} retained (in the source only).`);
  const items: Record<string, number> = {};
  for (const r of reports) for (const [k, v] of Object.entries(r.items)) items[k] = (items[k] ?? 0) + v;
  const list = Object.entries(items)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${n(v)} ${k}`);
  lines.push(`Items: ${list.join(", ")} (${mb(sum((r) => r.item_bytes))}); ${n(sum((r) => r.requests))} requests (${mb(sum((r) => r.request_bytes))}); ${n(sum((r) => r.origins))} origins.`);
  lines.push(`Events: ${n(sum((r) => r.events))} (${mb(sum((r) => r.event_bytes))}), of which each thread's last ${n(store.KEEP_EVENTS)} are ${mb(sum((r) => r.kept_event_bytes))}.`);
  const slowest = [...reports].sort((a, b) => b.ms - a.ms).slice(0, examples);
  lines.push(`Slowest: ${slowest.map((r) => `${r.key} (${n(r.messages)} messages) ${r.ms.toFixed(0)} ms`).join(", ")}.`);
  if (written) {
    const tables = written.tables ? ` (${Object.entries(written.tables).map(([t, b]) => `${t} ${mb(b)}`).join(", ")}, with their indexes)` : "";
    lines.push(`Written to ${written.file} in ${(written.ms / 1000).toFixed(1)}s: ${mb(written.bytes)}${tables}.`);
  }
  const blocked = new Map<string, string[]>();
  for (const r of reports) for (const b of r.blockers) blocked.set(b, [...(blocked.get(b) ?? []), r.key]);
  lines.push("", `Can't be switched over now: ${n(reports.filter((r) => r.blockers.length).length)} tasks.`);
  for (const [b, keys] of [...blocked].sort()) lines.push(`  ${b}: ${n(keys.length)} (${keys.slice(0, examples).join(", ")})`);
  const warnings = new Map<string, { count: number; examples: string[]; tasks: Set<string> }>();
  for (const r of reports) {
    for (const w of r.warnings) {
      const e = warnings.get(w.code) ?? { count: 0, examples: [], tasks: new Set() };
      warnings.set(w.code, e);
      e.count++;
      e.tasks.add(r.key);
      if (e.examples.length < examples) e.examples.push(`${r.key}${w.message_id !== null ? ` #${w.message_id}` : ""}: ${w.text}`);
    }
  }
  lines.push("", `Warnings:${warnings.size ? "" : " none."}`);
  for (const [code, e] of [...warnings].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${code}: ${n(e.count)} in ${n(e.tasks.size)} tasks`);
    for (const x of e.examples) lines.push(`    ${x}`);
  }
  if (failed.length) {
    lines.push("", "Failed:");
    for (const r of failed.slice(0, Math.max(1, examples) * 4)) lines.push(`  ${r.key}: ${r.error}`);
  }
  const largest = [...reports].sort((a, b) => b.item_bytes + b.event_bytes - (a.item_bytes + a.event_bytes)).slice(0, examples);
  lines.push("", "Largest threads:");
  for (const r of largest) {
    lines.push(`  ${r.key}: ${n(r.messages)} messages (${mb(r.message_bytes)}) → ${n(Object.values(r.items).reduce((a, b) => a + b, 0))} items (${mb(r.item_bytes)}), ${n(r.events)} events (${mb(r.event_bytes)})`);
  }
  return lines.join("\n") + "\n";
}
