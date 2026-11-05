// Port of server/src/git/checkpoints/git.rs: running git for checkpoints: scratch indexes, snapshots of the worktree,
// and keeping and pruning checkpoint refs.
//
// Paths from git are bytes, as in Rust: they're kept as latin1 strings (one char per byte, so any path round-trips),
// turned into Buffers for the file system and git's stdin, and decoded as UTF-8 (`lossy`) for the API.
import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import * as documents from "../../agent/documents.ts";
import type { AppState } from "../../state.ts";
import { context, expand_tilde, new_id } from "../../util.ts";
import { MAX_CHECKPOINTS, MAX_UNTRACKED, MAX_UNTRACKED_FILE, insert, ref_name, type Checkpoint } from "../checkpoints.ts";

export interface Out {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

/** The output, as text, trimmed. */
export function text(o: Out): string {
  return o.stdout.toString("utf8").trim();
}

const CLEARED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

/** Runs git at `dir` with `env` and `input` on its stdin, never with a git environment the server may have been started with. */
export function run(dir: string, args: string[], env: Record<string, string> = {}, input: Buffer | string | null = null): Promise<Out> {
  return new Promise((resolve, reject) => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of CLEARED) delete e[k];
    e.GIT_TERMINAL_PROMPT = "0";
    e.GIT_OPTIONAL_LOCKS = "0";
    Object.assign(e, env);
    const child = spawn("git", ["-C", dir, ...args], { env: e, stdio: [input !== null ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (x) => reject(context("failed to run git", x)));
    child.on("close", (code) => resolve({ ok: code === 0, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8").trim() }));
    if (input !== null) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

export async function run_ok(dir: string, args: string[], env: Record<string, string> = {}, input: Buffer | string | null = null): Promise<Out> {
  const o = await run(dir, args, env, input);
  if (!o.ok) throw new Error(`git ${args[0] ?? ""} failed: ${o.stderr}`);
  return o;
}

/** NUL-separated output's non-empty parts, as latin1 strings (bytes). */
export function split_nul(bytes: Buffer): string[] {
  return bytes.toString("latin1").split("\0").filter((p) => p !== "");
}

/** A path from git (a latin1 string of its bytes) as text. */
export function lossy(p: string): string {
  return Buffer.from(p, "latin1").toString("utf8");
}

/** A path from git (a latin1 string of its bytes) under `top`, for the file system. */
export function fs_path(top: string, rel: string): Buffer {
  return Buffer.concat([Buffer.from(top), Buffer.from("/"), Buffer.from(rel, "latin1")]);
}

/** NUL-terminated paths (latin1 strings of their bytes), as `--stdin -z` and `--pathspec-file-nul` take them. */
export function nul_list(paths: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  for (const p of paths) parts.push(Buffer.from(p, "latin1"), Buffer.from([0]));
  return Buffer.concat(parts);
}

/** An index of our own in the worktree's git directory, removed with `drop`. */
export class ScratchIndex {
  path: string;
  constructor(path: string) {
    this.path = path;
  }

  /** A copy of the worktree's index (so `git add` only looks again at what changed), or an empty one. */
  static async create(top: string, copy: boolean): Promise<ScratchIndex> {
    const index = text(await run_ok(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    const scratch = new ScratchIndex(join(dirname(index), `huntaway-checkpoint-${new_id()}.index`));
    if (copy) {
      try {
        copyFileSync(index, scratch.path);
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw context("copying the worktree's index", e);
      }
    }
    return scratch;
  }

  env(): Record<string, string> {
    return { GIT_INDEX_FILE: this.path };
  }

  drop() {
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.lock`, { force: true });
  }
}

/** A snapshot of a worktree's files. */
export interface Snap {
  sha: string;
  tree: string;
  head: string | null;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Huntaway",
  GIT_AUTHOR_EMAIL: "huntaway@localhost",
  GIT_COMMITTER_NAME: "Huntaway",
  GIT_COMMITTER_EMAIL: "huntaway@localhost",
};

export async function head(top: string): Promise<string | null> {
  const o = await run(top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  const h = o.ok ? text(o) : "";
  return h !== "" ? h : null;
}

/**
 * The tree of everything in the worktree at `top` that git doesn't ignore, and its HEAD, as a commit (`last`'s, when
 * nothing has changed since it).
 */
export async function snapshot(top: string, last: Checkpoint | null): Promise<Snap> {
  // Before the files, so a commit made meanwhile shows up in the files rather than only in HEAD.
  const h = await head(top);
  const scratch = await ScratchIndex.create(top, true);
  let tree: string;
  try {
    const env = scratch.env();
    const untracked = split_nul((await run_ok(top, ["ls-files", "-z", "--others", "--exclude-standard"], env)).stdout);
    if (untracked.length > MAX_UNTRACKED) {
      throw new Error(`the worktree has ${untracked.length} untracked files, too many to take a checkpoint of (should some be ignored?)`);
    }
    const spec: Buffer[] = [Buffer.from(".\0")];
    for (const p of untracked) {
      let big = false;
      try {
        const m = lstatSync(fs_path(top, p));
        big = m.isFile() && m.size > MAX_UNTRACKED_FILE;
      } catch {}
      if (big) spec.push(Buffer.from(":(exclude,literal)"), Buffer.from(p, "latin1"), Buffer.from([0]));
    }
    // A file that can't be read is left out, rather than the whole checkpoint.
    const added = await run(
      top,
      ["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
      env,
      Buffer.concat(spec),
    );
    if (!added.ok) console.warn(`git add for a checkpoint in ${top}: ${added.stderr}`);
    tree = text(await run_ok(top, ["write-tree"], env));
  } finally {
    scratch.drop();
  }
  if (last && last.tree === tree && last.head === h) return { sha: last.sha, tree, head: h };
  const args = ["commit-tree", "--no-gpg-sign", "-m", "Huntaway checkpoint"];
  if (h !== null) args.push("-p", h);
  args.push(tree);
  const sha = text(await run_ok(top, args, IDENTITY));
  return { sha, tree, head: h };
}

/** The top of a task's own worktree, if it has one that's ready. */
export async function worktree_top(state: AppState, task_id: string): Promise<string | null> {
  const task = db.get_task(state.db(), task_id);
  if (!task) return null;
  const wt = own_worktree(state, task);
  if (wt === null) return null;
  const o = await run(wt, ["rev-parse", "--show-toplevel"]);
  return o.ok ? text(o) : null;
}

/**
 * The worktree a task's checkpoints are of: its own, once it's set up. Not a review thread's (it works in its task's)
 * nor a document's or scratch task's (they work in folders of their own).
 */
export function own_worktree(state: AppState, task: Task): string | null {
  if (task.kind !== "task" || !task.use_worktree || task.worktree_state !== "ready" || documents.work_dir(state, task) != null) return null;
  if (task.worktree_path == null) return null;
  const p = expand_tilde(task.worktree_path);
  try {
    return statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/** Store `snap` as the task's next checkpoint: its ref, then its row. */
export async function keep(state: AppState, task_id: string, top: string, snap: Snap, cp: (n: number) => Checkpoint): Promise<Checkpoint> {
  const n = Number(db.value(state.db(), "SELECT COALESCE(MAX(n), -1) + 1 FROM checkpoints WHERE task_id=?1", task_id));
  const name = ref_name(task_id, n);
  await run_ok(top, ["update-ref", name, snap.sha]);
  const c = cp(n);
  try {
    insert(state.db(), task_id, c);
  } catch (e) {
    await run(top, ["update-ref", "-d", name]).catch(() => {});
    throw e;
  }
  return c;
}

/** Drop a task's oldest checkpoints past MAX_CHECKPOINTS. */
export async function prune(state: AppState, task_id: string, top: string): Promise<void> {
  const old = db
    .all<{ n: number }>(state.db(), "SELECT n FROM checkpoints WHERE task_id=?1 ORDER BY n DESC LIMIT -1 OFFSET ?2", task_id, MAX_CHECKPOINTS)
    .map((r) => r.n);
  if (old.length === 0) return;
  const input = old.map((n) => `delete ${ref_name(task_id, n)}\n`).join("");
  await run_ok(top, ["update-ref", "--stdin"], {}, input);
  for (const n of old) db.run(state.db(), "DELETE FROM checkpoints WHERE task_id=?1 AND n=?2", task_id, n);
}
