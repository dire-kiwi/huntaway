// `huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all | --batch) [--check] [--json]`:
// derives tasks' threads kept as items from their messages again (threads/write.ts's rebuild), one transaction a task,
// so a translator fix only needs a rebuild. A task named is flagged `thread_items` too, and keeps its items written live
// from then on; `--all` is every flagged task. `--batch` is step 7's batch (threads/batch.ts): every task that isn't
// done whose thread this build doesn't keep as items yet, printing its progress as it goes; it can be stopped and run
// again, and goes on with the rest. `--check` changes nothing: it says how each thread differs from a rebuild.
//
// A task whose items are its thread's source (threads/source.ts) has no messages since it moved onto them, so it isn't
// rebuilt: `--all` and `--batch` leave it out, and one named fails. (`--back`, which moved one back onto its messages,
// went with the messages path in step 13.)
//
// It works on the board's database while the server runs (the data dir's, by default), as each rebuild is one
// transaction, which takes the database's write lock as it starts, and a running server's translators check the threads'
// `writes` before their next write. Clients showing a rebuilt thread find a gap at its next event, and take a fresh
// window (the server's own batch, from Settings → Server, tells them at once). The database must be at this build's
// version: it isn't migrated.
import { DatabaseSync } from "node:sqlite";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { db_file } from "./report.ts";
import { pending } from "./batch.ts";
import { compare, rebuild, type Rebuilt } from "./write.ts";

export interface Options {
  db: string | null;
  tasks: string[];
  all: boolean;
  batch: boolean;
  check: boolean;
  json: boolean;
}

const USAGE = "Usage: huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all | --batch) [--check] [--json]";

export function parse_args(args: string[]): Options {
  const o: Options = { db: null, tasks: [], all: false, batch: false, check: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--db" || a === "--data-dir") {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o.db = v;
    } else if (a === "--all") o.all = true;
    else if (a === "--batch") o.batch = true;
    else if (a === "--check") o.check = true;
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown argument ${a}\n${USAGE}`);
    else o.tasks.push(a);
  }
  if (Number(o.all) + Number(o.batch) + Number(!!o.tasks.length) !== 1) throw new Error(`name the tasks, or --all, or --batch\n${USAGE}`);
  return o;
}

/** Opens the board's database to write, at the version this build has. */
export function open(path: string): Conn {
  const file = db_file(path);
  const c = new DatabaseSync(file);
  c.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  const version = db.value<number>(c, "PRAGMA user_version") ?? 0;
  if (version !== db.VERSION) {
    c.close();
    throw new Error(`${file} is at database version ${version}, and this build has version ${db.VERSION}: run the build that serves it`);
  }
  return c;
}

/** The ids of tasks given by id or key (`<project key>-<number>`). */
function task_ids(c: Conn, names: string[]): string[] {
  return names.map((name) => {
    const r = db.one<{ id: string }>(
      c,
      "SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id=?1 OR lower(p.key || '-' || t.number)=lower(?1)",
      name,
    );
    if (!r) throw new Error(`no task ${name}`);
    return r.id;
  });
}

export interface Result {
  task_id: string;
  rebuilt?: Omit<Rebuilt, "task_id">;
  /** With --check: how its items differ from a rebuild (none if they don't). */
  differences?: string[];
  error?: string;
}

export function run(o: Options, c: Conn, print: (s: string) => void = (s) => process.stdout.write(s)): Result[] {
  const ids = o.all
    ? db.all<{ id: string }>(c, "SELECT id FROM tasks WHERE thread_items=1 AND thread_source<>'items' ORDER BY created_at, id").map((r) => r.id)
    : o.batch
      ? pending(c)
      : task_ids(c, o.tasks);
  const out: Result[] = [];
  const start = performance.now();
  const width = String(ids.length).length;
  for (const [i, id] of ids.entries()) {
    let r: Result;
    try {
      if (o.check) r = { task_id: id, differences: compare(c, id) };
      else {
        const { task_id: _, ...rebuilt } = rebuild(c, id, true);
        r = { task_id: id, rebuilt };
      }
    } catch (e: any) {
      r = { task_id: id, error: e?.stack ?? String(e) };
    }
    out.push(r);
    // As it goes, so a long batch shows its progress.
    if (!o.json) print(`${o.batch ? `[${String(i + 1).padStart(width)}/${ids.length}] ` : ""}${line(r)}\n`);
  }
  if (o.json) print(JSON.stringify(out, null, 2) + "\n");
  else {
    const failed = out.filter((r) => r.error).length;
    const differ = out.filter((r) => r.differences?.length).length;
    const s = ((performance.now() - start) / 1000).toFixed(1);
    print(`${out.length} tasks${o.check ? `, ${differ} differ from a rebuild` : " rebuilt"}${failed ? `, ${failed} failed` : ""}, in ${s} s\n`);
  }
  return out;
}

function line(r: Result): string {
  if (r.error) return `${r.task_id}: failed: ${r.error}`;
  if (r.differences)
    return `${r.task_id}: ${r.differences.length ? `${r.differences.length} differences\n  ${r.differences.join("\n  ")}` : "same as a rebuild"}`;
  const b = r.rebuilt!;
  const w = b.warnings.length ? `, ${b.warnings.length} warnings (${[...new Set(b.warnings.map((w) => w.code))].join(", ")})` : "";
  return `${r.task_id}: ${b.messages} messages, ${b.items} items, ${b.requests} requests${w}`;
}

/** The command line's entry: exits 1 if a task failed (or, with --check, differs). */
export async function main(args: string[]): Promise<void> {
  const o = parse_args(args);
  let path = o.db;
  if (!path) path = process.env.IA_DATA_DIR || (await import("../serve.ts")).default_data_dir();
  const c = open(path);
  try {
    const out = run(o, c);
    if (out.some((r) => r.error || r.differences?.length)) process.exitCode = 1;
  } finally {
    c.close();
  }
}
