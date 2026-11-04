// Port of server/src/testing.rs: test helpers. (`run`/`run_within` aren't needed: node:test has timeouts, and an
// async test is just an async function.)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import * as db from "./db.ts";
import { AppState, type Identity } from "./state.ts";
import type { ServerMeta } from "./update/admin.ts";

// `when` and `reached` are in util.ts, so the server's own code can mark points without importing node:test.
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

function state_of(id: Identity, m: ServerMeta): AppState {
  return new AppState(db.open(":memory:"), temp_dir(), id, m);
}

let root: string | null = null;
const dirs: string[] = [];

// Registered as the module loads (at a test file's top level, through its imports), so it runs once the file's tests have
// ended: registered inside a test, it would run when that test ends.
after(() => {
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
