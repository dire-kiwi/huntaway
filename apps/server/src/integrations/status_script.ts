// Port of server/src/integrations/status_script.rs.
/**
 * A project's status scripts: its status script runs with bash whenever one of its tasks moves
 * to another column, and each column's script whenever a task moves into that column, whatever
 * moved it (the user, its agent, a review, a merge), e.g. to notify someone, update another
 * tracker or clean up a done task's build. They run in the background in the task's worktree
 * (the repository when the task has none), and a task's scripts run one at a time in the order
 * its status changed, the status script before the column's. Their output goes in the task's
 * thread.
 */
import { statSync } from "node:fs";
import * as db from "../db.ts";
import type { Conn, Project, Task } from "../db.ts";
import * as worktree from "../git/worktree.ts";
import type { Shared } from "../state.ts";
import { err_str, truncate } from "../util.ts";

/** How long a status script may run before it's stopped (milliseconds). */
const LIMIT = 300_000;

interface Change {
  /** The task right after the change. */
  task: Task;
  old: string;
}

/** Each task's queue of changes whose scripts haven't run yet, while it has any. */
export const QUEUES = new Map<string, Change[]>();

/**
 * A task's status moved from `old` to `task.status`: queue its project's scripts for it. Call it
 * right after the change (`c` is the connection it was made on), so that changes to a task
 * are queued in the order they were made.
 */
export function status_changed(state: Shared, c: Conn, task: Task, old: string): void {
  if (task.kind !== "task" || task.status === old) return;
  const pid = task.project_id;
  if (!pid) return;
  let has_script = false;
  try {
    const p = db.get_project(c, pid);
    has_script = !!p && scripts(p, task.status).length > 0;
  } catch {}
  if (!has_script) return;
  const change: Change = { task, old };
  const q = QUEUES.get(task.id);
  if (q) {
    q.push(change);
    return;
  }
  QUEUES.set(task.id, [change]);
  run_queue(state, task.id).catch((e) => console.error(`status scripts of ${task.id}:`, e));
}

/** Run a task's queued scripts until there are none left. */
async function run_queue(state: Shared, task_id: string): Promise<void> {
  for (;;) {
    const q = QUEUES.get(task_id);
    const change = q?.shift();
    if (!change) {
      QUEUES.delete(task_id);
      return;
    }
    try {
      await run(state, change);
    } catch (e) {
      console.error(`status script of ${task_id}:`, e);
    }
  }
}

/** The scripts to run when a task moves to `status`, each with its name for the thread: the project's status script, then the column's. */
function scripts(project: Project, status: string): Array<[string, string]> {
  const out: Array<[string, string]> = [["Status script", project.status_script ?? ""]];
  const col = project.status_scripts?.[status];
  if (typeof col === "string") out.push([`${label(status)} script`, col]);
  return out.filter(([, s]) => s.trim() !== "");
}

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

async function run(state: Shared, { task, old }: Change): Promise<void> {
  // The scripts as they are now, in case they changed since.
  let project: Project | null = null;
  try {
    project = task.project_id ? db.get_project(state.db(), task.project_id) : null;
  } catch {}
  if (!project) return;
  const list = scripts(project, task.status);
  if (!list.length) return;
  const wt = task.worktree_path && task.worktree_state === "ready" && is_dir(task.worktree_path) ? task.worktree_path : null;
  const dir = wt ?? project.repo_path;
  const env = script_env(project, task, wt, old);
  const change = `${label(old)} → ${label(task.status)}`;
  for (const [name, script] of list) {
    try {
      const log = String(await worktree.run_script(script, dir, env, LIMIT)).trim();
      state.add_event(task.id, "info", `${name} ran (${change})`, log ? truncate(log, 20000) : null);
    } catch (e) {
      state.add_event(task.id, "warn", `${name} failed (${change})`, err_str(e));
    }
  }
}

/** The setup script's variables (with an empty IA_WORKTREE_PATH when the task has no worktree), and the change. */
function script_env(project: Project, task: Task, wt: string | null, old: string): Array<[string, string]> {
  let env: Array<[string, string]> = [...worktree.script_env(project, task, wt ?? "", task.branch ?? "")];
  env.push(
    ["IA_TASK_KEY", `${project.key}-${task.number}`],
    ["IA_TASK_TITLE", task.title],
    ["IA_OLD_STATUS", old],
    ["IA_NEW_STATUS", task.status],
    ["IA_RESOLUTION", task.resolution ?? ""],
    ["IA_PR_URL", task.pr_url ?? ""],
  );
  if (wt === null) {
    env = env.filter(([k]) => k !== "IA_WORKTREE_PATH");
    env.push(["IA_WORKTREE_PATH", ""]);
  }
  return env;
}

/** A status's column name on the board. */
function label(status: string): string {
  const labels: Record<string, string> = {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    needs_attention: "Needs attention",
    in_review: "In review",
    ready_for_merge: "Ready for merge",
    done: "Done",
  };
  return Object.hasOwn(labels, status) ? labels[status] : status;
}
