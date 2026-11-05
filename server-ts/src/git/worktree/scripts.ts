// Port of server/src/git/worktree/scripts.rs.
/** Running a project's setup and teardown scripts. */
import { spawn } from "node:child_process";
import type { Project, Task } from "../../db.ts";
import { context, path_str, truncate } from "../../util.ts";
import { output, type RawOutput } from "../worktree.ts";

/**
 * How long a setup or teardown script may run (an install or a build, say), in milliseconds: it holds the task's setup
 * lock and its project's folder in place meanwhile, so one that hangs is stopped.
 */
export const SCRIPT_LIMIT = 30 * 60 * 1000;

/** Rust's `ExitStatus` as it displays: `exit status: 1`, `signal: 9 (SIGKILL)`. */
function status_str(code: number | null, signal: string | null): string {
  if (code !== null) return `exit status: ${code}`;
  return `signal: ${signal ?? "?"}`;
}

/** A duration as Rust's `Duration` debug-prints (`1800s`, `500ms`). */
function duration_str(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
}

/** Run a project script with bash. With a time limit (milliseconds), it's stopped (with everything it started) if it runs over. */
export async function run_script(script: string, cwd: string, env: Array<[string, string]>, limit: number | null): Promise<string> {
  const full: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of env) full[k] = v;
  let out: RawOutput & { signal?: string | null };
  if (limit !== null) out = await run_limited(script, cwd, full, limit);
  else {
    try {
      out = await output("bash", ["-c", script], { cwd, env: full });
    } catch (e) {
      throw context("failed to run script", e);
    }
  }
  const log = out.stdout.toString() + out.stderr.toString();
  if (!out.success) throw new Error(`script exited with ${status_str(out.code, out.signal ?? null)}\n${truncate(log, 8000)}`);
  return log;
}

/** Kills a process group when dropped (`drop()`). */
export class KillGroup {
  pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  drop() {
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {}
  }
}

/**
 * Run a script in a process group of its own, which is killed if the script runs over `limit`, so nothing it started
 * keeps running.
 */
function run_limited(script: string, cwd: string, env: NodeJS.ProcessEnv, limit: number): Promise<RawOutput & { signal: string | null }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("bash", ["-c", script], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(context("failed to run script", e));
    }
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    let over = false;
    const group = child.pid !== undefined ? new KillGroup(child.pid) : null;
    const timer = setTimeout(() => {
      over = true;
      group?.drop();
    }, limit);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(context("failed to run script", e));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      if (over) {
        const log = stdout.toString() + stderr.toString();
        return reject(new Error(`script still running after ${duration_str(limit)}; stopped it\n${truncate(log, 8000)}`));
      }
      // It finished: anything it left running was started to outlive it.
      resolve({ code, signal, success: code === 0, stdout, stderr });
    });
  });
}

export function script_env(project: Project, task: Task, wt: string, branch: string): Array<[string, string]> {
  return [
    ["IA_REPO_PATH", project.repo_path],
    ["IA_WORKTREE_PATH", path_str(wt)],
    ["IA_BRANCH", branch],
    ["IA_TASK_ID", task.id],
    ["IA_TASK_NUMBER", String(task.number)],
    ["IA_PROJECT_KEY", project.key],
  ];
}
