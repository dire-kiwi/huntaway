// Port of server/src/testing.rs: test helpers. (`run`/`run_within` aren't needed: Vitest has timeouts, and an
// async test is just an async function.)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import * as db from "./db.ts";
import * as source from "./threads/source.ts";
import { AppState, type Identity } from "./state.ts";
import type { ServerMeta } from "./update/admin.ts";

// `when` and `reached` are in util.ts, so the server's own code can mark points without importing the test runner.
export { when, reached } from "./util.ts";

export function meta(): ServerMeta {
  return { boot_id: "", started_at: "", source_dir: null, running_commit: null, update_from: null, release: null, args: [] };
}

function identity(): Identity {
  return { host_id: "h", host_name: "desktop", token: "", hub_token: "", internal_url: "" };
}

/** An `AppState` on an in-memory database, with a temp data dir removed when the test file's tests end. */
export function state(): AppState {
  return state_with(meta());
}

/** `state()` with this `meta`. */
export function state_with(m: ServerMeta): AppState {
  return state_of(identity(), m);
}

/** An `AppState` on an in-memory database, for a host with these ids, tokens and URL. */
export function state_as(id: Identity): AppState {
  return state_of(id, meta());
}

/** An `AppState` on an in-memory database, with its data in `data_dir`, for a server whose binary is `exe`. */
export function state_at(m: ServerMeta, data_dir: string, exe: string): AppState {
  return AppState.with_exe(db.open(":memory:"), data_dir, identity(), m, exe);
}

/** An `AppState` on the database `conn`, with its data in `data_dir`. */
export function state_on(conn: db.Conn, data_dir: string): AppState {
  return new AppState(conn, data_dir, identity(), meta());
}

function state_of(id: Identity, m: ServerMeta): AppState {
  return on_items(new AppState(db.open(":memory:"), temp_dir(), id, m));
}

/**
 * Whether tasks on `s`'s board move onto items (threads/source.ts), as they do on a server's: on by default, as there,
 * and off for a test of a task on messages (`items` false), which a server has only until it moves. The messages its
 * items tasks are written as are kept for `messages`.
 */
export function on_items<S extends { db(): db.Conn }>(s: S, items = true): S {
  source.set_flips(s.db(), items);
  source.keep_journal(s.db());
  return s;
}

/**
 * The messages written to task `task_id`'s thread, as db.list_messages gives them, whichever its source: its rows, and
 * for a task on items (which has none since it moved), the messages it was written as (source.ts's journal), as they
 * are now. What the board wrote, for tests to check; the board's own readers read items (threads/history.ts).
 */
/** Message `id` as `messages` has it (its data as it is now), or undefined. */
export function message(c: db.Conn, id: number): db.Message | undefined {
  const m = source.keep_journal(c).get(id);
  if (m) return structuredClone(m);
  const r = db.one(c, "SELECT * FROM messages WHERE id=?1", id);
  return r ? db.Message_from_row(r) : undefined;
}

export function messages(c: db.Conn, task_id: string): db.Message[] {
  const out = new Map(db.list_messages(c, task_id).map((m) => [Number(m.id), m]));
  for (const m of source.keep_journal(c).values()) if (m.task_id === task_id) out.set(Number(m.id), structuredClone(m));
  return [...out.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

let root: string | null = null;
const dirs: string[] = [];

// Registered as the module loads (at a test file's top level, through its imports, while Vitest collects the file's
// tests, which is when it takes hooks), so it runs once the file's tests have ended.
afterAll(() => {
  if (!root) return;
  if (process.env.IA_KEEP_TEST_DIRS && process.env.IA_KEEP_TEST_DIRS !== "0") {
    console.error(`kept test folders in ${root}`);
    return;
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  root = null;
});

/** This test process's folder for tests' folders, removed when its tests end. */
function temp_root(): string {
  root ??= mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ia-ts-test-"));
  return root;
}

/** A new, empty folder for a test, removed with what the test made in it when the file's tests end. */
export function temp_dir(): string {
  const dir = mkdtempSync(join(temp_root(), "t-"));
  dirs.push(dir);
  return dir;
}

/** `mkdir -p`. */
export function mkdirs(p: string) {
  mkdirSync(p, { recursive: true });
}
