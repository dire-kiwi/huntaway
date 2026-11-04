// Port of server/src/git/worktree.rs.
/**
 * Git worktree lifecycle for tasks: setup (worktree add, ignored files, setup script), teardown (teardown script +
 * worktree remove), and diffs for review.
 */
import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import * as db from "../db.ts";
import type { Project, Task } from "../db.ts";
import type { AppState } from "../state.ts";
import { context } from "../util.ts";

export * from "./worktree/upstream.ts";
export * from "./worktree/scripts.ts";
export * from "./worktree/setup.ts";
export * from "./worktree/start.ts";
export * from "./worktree/remove.ts";
export * from "./worktree/pr.ts";
export * from "./worktree/remote.ts";
export * from "./worktree/changes.ts";

export interface Output {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** What a program printed, as bytes, and how it exited (`std::process::Output`). */
export interface RawOutput {
  /** The exit code, or null if it was killed by a signal. */
  code: number | null;
  success: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Run `cmd` with `args`, collecting its output as bytes. Rejects only if it couldn't be started (as `.output()`).
 * `input` is written to its stdin (else stdin is empty).
 */
export function output(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer | string; timeout?: number } = {},
): Promise<RawOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, maxBuffer: 1 << 30, timeout: opts.timeout, encoding: "buffer" },
      (err: any, stdout: Buffer, stderr: Buffer) => {
        if (err && typeof err.code === "string" && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(err);
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ code, success: code === 0, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) });
      },
    );
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** The environment git runs in: never asking for credentials. */
export function git_env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

export async function git(dir: string, args: string[]): Promise<Output> {
  let out: RawOutput;
  try {
    out = await output("git", ["-C", dir, ...args], { env: git_env() });
  } catch (e) {
    throw context("failed to run git", e);
  }
  return { ok: out.success, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

export async function git_ok(dir: string, args: string[]): Promise<string> {
  const o = await git(dir, args);
  if (!o.ok) throw new Error(`git ${args.join(" ")} failed: ${o.stderr.trim()}`);
  return o.stdout;
}

export async function is_git_repo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--git-dir"])).ok;
  } catch {
    return false;
  }
}

export async function current_branch(dir: string): Promise<string | null> {
  try {
    const o = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    const s = o.stdout.trim();
    return o.ok && s ? s : null;
  } catch {
    return null;
  }
}

/**
 * Whether git takes `name` for a branch name (`git check-ref-format --branch`), run outside any repository so that
 * `@{-1}` (the branch checked out before) isn't taken for the one it names.
 */
export function valid_branch_name(name: string): boolean {
  if (name.includes("@{")) return false;
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const run = spawnSync("git", ["check-ref-format", "--branch", name], { cwd: "/", env, stdio: "ignore" });
  return !run.error && run.status === 0;
}

/** The worktree (main checkout included) that has `branch_ref` checked out, if any. */
export async function checked_out_in(repo: string, branch_ref: string): Promise<string | null> {
  let list: string;
  try {
    list = await git_ok(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    return null;
  }
  let dir: string | null = null;
  for (const line of lines(list)) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && line.slice("branch ".length) === branch_ref) return dir;
  }
  return null;
}

/** Whether `dir` is one of `repo`'s worktrees (the main checkout included), by git's own list. */
export async function is_worktree_of(repo: string, dir: string): Promise<boolean> {
  let list: string;
  try {
    list = await git_ok(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    return false;
  }
  const d = canonicalize(dir) ?? dir;
  return lines(list)
    .filter((l) => l.startsWith("worktree "))
    .some((l) => canonicalize(l.slice("worktree ".length)) === d);
}

/** The commit `rev` names, if it names one. */
export async function commit(repo: string, rev: string): Promise<string | null> {
  try {
    return (await git_ok(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
  } catch {
    return null;
  }
}

/** Whether commit `a` is in `b`'s history (or is `b`). */
export async function is_ancestor(repo: string, a: string, b: string): Promise<boolean> {
  try {
    return (await git(repo, ["merge-base", "--is-ancestor", a, b])).ok;
  } catch {
    return false;
  }
}

export function plural(n: string): string {
  return n === "1" ? "" : "s";
}

export function load(state: AppState, task_id: string): [Task, Project] {
  const c = state.db();
  const task = db.get_task(c, task_id);
  if (!task) throw new Error("task not found");
  const pid = task.project_id;
  if (!pid) throw new Error("task has no project");
  const project = db.get_project(c, pid);
  if (!project) throw new Error("project not found");
  return [task, project];
}

/** The lines of a text, as Rust's `str::lines` (no last empty line, `\r\n` too). */
export function lines(s: string): string[] {
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** `Path::canonicalize`: the real path, or null if it can't be resolved. */
export function canonicalize(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** `Path::starts_with`: whether `p` is `base` or inside it, by whole components. */
export function path_starts_with(p: string, base: string): boolean {
  const a = trim_slashes(p), b = trim_slashes(base);
  if (b === "") return p.startsWith("/") === base.startsWith("/") || a === "";
  return a === b || a.startsWith(b === "/" ? "/" : b + "/");
}

/** `Path::strip_prefix`: the rest of `p` after `base` (by whole components), or null. */
export function strip_path_prefix(p: string, base: string): string | null {
  if (!path_starts_with(p, base)) return null;
  const a = trim_slashes(p), b = trim_slashes(base);
  if (a === b) return "";
  return a.slice(b === "/" ? 1 : b.length + 1);
}

function trim_slashes(p: string): string {
  let s = p.replace(/\/+/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Whether two paths are the same by their components (`PathBuf == PathBuf`). */
export function same_path(a: string, b: string): boolean {
  return trim_slashes(a) === trim_slashes(b);
}
