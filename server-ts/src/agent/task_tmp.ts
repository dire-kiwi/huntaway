// Port of server/src/agent/task_tmp.rs.
/**
 * Each task's agents get a temp folder of their own, `$TMPDIR` for its runs and terminals, so what they leave in it
 * (test servers' data, build output, logs, browsers' profiles) goes with the task rather than piling up in /tmp:
 * `<system temp>/ha-<data dir's hash>/<start of the task id>`. A review thread uses the folder of the task it reviews,
 * as it works in that task's worktree.
 *
 * The path is kept short (`/tmp/ha-0123abcd/0123456789ab`) because programs put sockets in their TMPDIR, whose paths
 * can't be longer than 107 bytes: Chromium's ProcessSingleton socket is `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`,
 * 46 bytes more, and scripts/ui-check.mjs puts the browser's TMPDIR in a folder of its own in the agent's (20 more). A
 * folder is named after the first 12 hex digits of its task's id, so it's found by those; two tasks that share them
 * (1 in 2^48) share a folder, which goes once both are done.
 *
 * A task's folder is removed as soon as the task is done and no agent works in it (its own or a reviewer), or when its
 * run ends if the task went to *Done* while it ran, and when the task is deleted; and every `SWEEP`, the folders of
 * tasks that are done or deleted (e.g. while the server was down). It's set up again if the task's agent runs again.
 * Each data dir has its own root, so a server only ever removes its own tasks' folders, not those of another server
 * (such as a test server) on the same machine.
 *
 * Nothing is removed unless the root is a folder (not a link) of this user's that nobody else can write to, and only
 * folders in it named like a task id (or being removed) are. Whether a folder can go is decided, and the folder renamed
 * away, in one synchronous step (Rust's `LOCK`), which `ensure` is too: as a run is registered (`AppState.runs`) before
 * it sets up its folder, a run starting meanwhile either keeps the folder or gets a new one.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, type Dirent } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState, Shared } from "../state.ts";
import * as worktree from "../git/worktree.ts";
import * as leftovers from "./leftovers.ts";
import { err_str, new_id, path_str, reached } from "../util.ts";

/** How often the folders of done and deleted tasks are looked for. */
const SWEEP_MS = 600_000;

/** Prefix of a folder being removed: renamed first, so a run starting meanwhile gets a new one. */
export const REMOVING = ".removing-";

/** Whether this is a test process (Rust's `cfg!(test)`): `node --test` sets NODE_TEST_CONTEXT in its test processes. */
const IN_TEST = !!process.env.NODE_TEST_CONTEXT;

/** The folder all of this server's tasks' temp folders are in. */
export function root(state: AppState): string {
  // A test's are in its own data dir, which goes when it ends.
  if (IN_TEST) return join(state.data_dir, "task-tmp");
  return root_in(tmpdir(), state.data_dir);
}

/** The root for data dir `data` in the system's temp folder `temp`. */
export function root_in(temp: string, data: string): string {
  const h = Number(fnv1a(Buffer.from(path_str(data))) & 0xffffffffn);
  return join(temp, `ha-${h.toString(16).padStart(8, "0")}`);
}

/** The name of task `id`'s folder: the first 12 hex digits of its id (a UUID, see util::new_id). */
export function folder(id: string): string {
  return [...id].filter((c) => /^[A-Za-z0-9]$/.test(c)).slice(0, 12).join("");
}

/** FNV-1a: a hash that stays the same across builds, so a new build finds the folders an older one made. */
export function fnv1a(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

/** The task whose folder `task`'s agent uses: a review thread's is the task it reviews. */
export function owner(task: Task): string {
  return task.kind === "review" && task.parent_id ? task.parent_id : task.id;
}

/** `task`'s temp folder (made or not). */
export function dir(state: AppState, task: Task): string {
  return join(root(state), folder(owner(task)));
}

/**
 * Make `task`'s temp folder (readable only by this user) and return it. Null, with a warning logged, if it can't be:
 * the agent then uses the system's temp folder, as it did before.
 */
export function ensure(state: AppState, task: Task): string | null {
  const d = dir(state, task);
  try {
    make(root(state), d);
    return d;
  } catch (e) {
    console.warn(`task ${task.id}: couldn't set up the task's temp folder ${d}: ${err_str(e)}`);
    return null;
  }
}

function make(root: string, dir: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  check_root(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * In a temp folder others can write to, the root must be a folder of this user's, not a link someone left there (to
 * make us write to or empty another folder), and no one else may write to it.
 */
function check_root(root: string) {
  const m = lstatSync(root);
  if (!m.isDirectory() || m.uid !== process.geteuid!() || (m.mode & 0o022) !== 0) {
    throw new Error(`${root} isn't a folder of this user's that only they can write to`);
  }
}

/** Whether an entry of the root is one of our folders: a folder (not a link), named after a task (see `folder`) or being removed. */
function ours(e: Dirent): boolean {
  const name = e.name;
  const task = name.length === 12 && /^[0-9a-f]+$/.test(name);
  return e.isDirectory() && (name.startsWith(REMOVING) || task);
}

/**
 * Call when task `t`'s status or running state changed: once it's done and its agents have stopped, its folder goes
 * (in the background). A review thread's change may be the last of the task's agents stopping.
 */
export function changed(state: Shared, t: Task) {
  if (t.kind === "task" && t.status !== "done") return;
  const name = folder(owner(t));
  if (!existsSync(join(root(state), name))) return;
  remove(state, name).catch((e) => console.warn(`folder ${name}: removing a task's temp folder: ${err_str(e)}`));
}

/** Call once task `id` has been deleted (with its agents stopped): its folder goes. */
export async function deleted(state: Shared, id: string) {
  await remove(state, folder(id));
}

/** The tasks whose folder is `name` (see `folder`): usually one, none once it's deleted. */
function tasks_of(state: Shared, name: string): Task[] {
  const c = state.db();
  const ids = db.all<{ id: string }>(c, "SELECT id FROM tasks WHERE kind != 'review' AND substr(replace(id, '-', ''), 1, 12) = ?1", name);
  return ids.map((r) => db.get_task(c, r.id)).filter((t): t is Task => !!t);
}

/** Whether folder `name` can go: its tasks are done (or deleted) and no agent works in them. */
function removable(state: Shared, name: string): boolean {
  let tasks: Task[];
  try {
    tasks = tasks_of(state, name);
  } catch (e) {
    console.warn(`folder ${name}: reading the tasks of a temp folder: ${err_str(e)}`);
    return false;
  }
  return tasks.every((t) => t.status === "done" && !t.running && !worktree.agent_in_worktree(state, t.id));
}

/** Remove folder `name` (see `folder`) if it can go (see `removable`). Returns whether it went. */
export async function remove(state: Shared, name: string): Promise<boolean> {
  const taken = take(state, name);
  if (!taken) return false;
  const { away, from } = taken;
  // The test servers its agents left running (and their agents), which would run on with their data gone.
  try {
    const worktrees = tasks_of(state, name).flatMap((t) => (t.worktree_path ? [t.worktree_path] : []));
    await leftovers.stop_task({ tmp: from, worktrees, data_dir: state.data_dir, tmp_root: root(state) }, `folder ${name}`);
  } catch (e) {
    console.warn(`folder ${name}: stopping what the task left running: ${err_str(e)}`);
  }
  try {
    await remove_all_async(away);
    console.log(`folder ${name}: removed a task's temp folder`);
  } catch (e) {
    console.warn(`folder ${name}: removing a task's temp folder: ${err_str(e)}`);
  }
  return true;
}

/**
 * Rename folder `id` away, if it can go, in one synchronous step: a run that starts later sets up a new one. Returns
 * where it went, and where it was (by the root's path and its real path, as processes started in it name it).
 */
function take(state: Shared, id: string): { away: string; from: string[] } | null {
  const r = root(state);
  try {
    check_root(r);
  } catch (e) {
    console.warn(`not removing anything from the tasks' temp folders: ${err_str(e)}`);
    return null;
  }
  const from = join(r, id);
  let isDir = false;
  try {
    isDir = lstatSync(from).isDirectory();
  } catch {}
  // Gone already (another removal got there first), or not one of ours?
  if (!isDir || !removable(state, id)) return null;
  reached("task_tmp:removable");
  const away = join(r, `${REMOVING}${id}-${new_id()}`);
  const was = leftovers.variants(from);
  try {
    renameSync(from, away);
  } catch {
    return null;
  }
  return { away, from: was };
}

/**
 * `remove_dir_all`, also when something in it took away its folders' write permission (as Go's module cache does),
 * which keeps their contents from being removed.
 */
export function remove_all(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {}
  if (!existsSync(dir)) return;
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
}

async function remove_all_async(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {}
  if (!existsSync(dir)) return;
  writable(dir);
  await rm(dir, { recursive: true, force: true });
}

function writable(dir: string) {
  try {
    chmodSync(dir, 0o700);
  } catch {}
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {}
  // Not following links out of the folder.
  for (const e of entries) if (e.isDirectory()) writable(join(dir, e.name));
}

/** Remove the folders of tasks that are done (with no agent working in them) or deleted, and any that a removal didn't finish. Returns how many went. */
export async function sweep(state: Shared): Promise<number> {
  const r = root(state);
  if (!existsSync(r)) return 0;
  try {
    check_root(r);
  } catch (e) {
    console.warn(`not sweeping the tasks' temp folders: ${err_str(e)}`);
    return 0;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(r, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries.filter(ours)) {
    if (e.name.startsWith(REMOVING)) {
      await remove_all_async(join(r, e.name)).catch(() => {});
    } else if (await remove(state, e.name)) {
      n++;
    }
  }
  try {
    await stop_orphans(state);
  } catch (e) {
    console.warn(`stopping what done tasks left running: ${err_str(e)}`);
  }
  return n;
}

/**
 * Stop the test servers (and their agents) whose data dirs are in folders of done or deleted tasks that have gone
 * already: removed by a server from before it stopped them first, or by hand. Those whose folder is still there are
 * stopped as it's removed.
 */
async function stop_orphans(state: Shared) {
  const r = root(state);
  const roots = leftovers.variants(r);
  const procs = await leftovers.list();
  if (!procs) return;
  for (const name of leftovers.folders_in(procs, roots)) {
    if (existsSync(join(r, name))) continue;
    let tasks: Task[];
    try {
      tasks = tasks_of(state, name);
    } catch {
      continue;
    }
    if (!tasks.every((t) => t.status === "done" && !t.running)) continue;
    const scope = { tmp: roots.map((x) => join(x, name)), worktrees: [], data_dir: state.data_dir, tmp_root: r };
    await leftovers.stop_task(scope, `folder ${name} (gone)`, procs);
  }
}

/** Sweeps the folders when the server starts, then every `SWEEP`. */
export function start_sweeper(state: Shared) {
  const tick = async () => {
    const n = await sweep(state);
    if (n > 0) console.log(`removed ${n} done or deleted tasks' temp folders`);
  };
  const run = () => tick().catch((e) => console.warn(`sweeping the tasks' temp folders: ${err_str(e)}`));
  run();
  setInterval(run, SWEEP_MS).unref();
}
