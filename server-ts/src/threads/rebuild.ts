// `huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all) [--check] [--json]`: derives tasks'
// threads kept as items from their messages again (threads/write.ts's rebuild), one transaction a task, so a translator
// fix only needs a rebuild. A task named is flagged `thread_items` too, and keeps its items written live from then on;
// `--all` is every flagged task. `--check` changes nothing: it says how each thread differs from a rebuild.
//
// It works on the board's database while the server runs (the data dir's, by default), as each rebuild is one
// transaction and a running server's translators check the threads' `writes` before their next write. Clients showing a
// rebuilt thread find a gap at its next event, and take a fresh window. The database must be at this build's version:
// it isn't migrated.
import { DatabaseSync } from "node:sqlite";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { db_file } from "./report.ts";
import { compare, rebuild, type Rebuilt } from "./write.ts";

export interface Options {
  db: string | null;
  tasks: string[];
  all: boolean;
  check: boolean;
  json: boolean;
}

const USAGE = "Usage: huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all) [--check] [--json]";

export function parse_args(args: string[]): Options {
  const o: Options = { db: null, tasks: [], all: false, check: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--db" || a === "--data-dir") {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o.db = v;
    } else if (a === "--all") o.all = true;
    else if (a === "--check") o.check = true;
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown argument ${a}\n${USAGE}`);
    else o.tasks.push(a);
  }
  if (o.all === !!o.tasks.length) throw new Error(`name the tasks, or --all\n${USAGE}`);
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
  const ids = o.all ? db.all<{ id: string }>(c, "SELECT id FROM tasks WHERE thread_items=1 ORDER BY created_at, id").map((r) => r.id) : task_ids(c, o.tasks);
  const out: Result[] = [];
  for (const id of ids) {
    try {
      if (o.check) out.push({ task_id: id, differences: compare(c, id) });
      else {
        const { task_id: _, ...rebuilt } = rebuild(c, id);
        out.push({ task_id: id, rebuilt });
      }
    } catch (e: any) {
      out.push({ task_id: id, error: e?.stack ?? String(e) });
    }
  }
  if (o.json) print(JSON.stringify(out, null, 2) + "\n");
  else {
    for (const r of out) {
      if (r.error) print(`${r.task_id}: failed: ${r.error}\n`);
      else if (r.differences) print(`${r.task_id}: ${r.differences.length ? `${r.differences.length} differences\n  ${r.differences.join("\n  ")}` : "same as a rebuild"}\n`);
      else if (r.rebuilt) {
        const w = r.rebuilt.warnings.length ? `, ${r.rebuilt.warnings.length} warnings (${[...new Set(r.rebuilt.warnings.map((w) => w.code))].join(", ")})` : "";
        print(`${r.task_id}: ${r.rebuilt.messages} messages, ${r.rebuilt.items} items, ${r.rebuilt.requests} requests${w}\n`);
      }
    }
    const failed = out.filter((r) => r.error).length;
    const differ = out.filter((r) => r.differences?.length).length;
    print(`${out.length} tasks${o.check ? `, ${differ} differ from a rebuild` : " rebuilt"}${failed ? `, ${failed} failed` : ""}\n`);
  }
  return out;
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
