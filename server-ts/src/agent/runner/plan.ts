/**
 * A plan that waits for the user (HA-198). A task with the plan label iterates on its plan with the user before it does
 * the work (see documents::labels_prompt), so a run that only wrote or revised the plan hasn't finished the task: it
 * waits for the user to read the plan, answer its questions or approve it. Such a run's task goes to "Needs attention"
 * rather than "In review".
 *
 * A run changed only the plan if it changed the plan, created no tasks (breaking an approved plan into tasks is doing the
 * work), and left the task's worktree as it was: no commits and no changed files, as the checkpoints of its turns say
 * (see git/checkpoints.rs). A task that works in its own folder rather than a worktree (one that makes only documents,
 * or a scratch task) has no code to change. One that works in its project's repository has no checkpoints, so its
 * runs can't be told apart: it goes to "In review" as before.
 */
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { err_str } from "../../util.ts";
import * as checkpoints from "../../git/checkpoints.ts";
import * as documents from "../documents.ts";

/** The attention reason of a task whose plan waits for the user. */
export const PLAN_READY = "Plan ready for review";

/**
 * Whether run `run` of `task` might have left its plan waiting for the user: it changed the plan and created no tasks.
 * Whether it changed anything else is for `changed_only_plan`.
 */
export function candidate(state: Shared, task: Task, run: Run): boolean {
  if (task.kind !== "task" || !documents.labels(task).includes("plan")) return false;
  const c = state.db();
  const changed = db.value<number>(c, "SELECT COUNT(*) FROM documents WHERE task_id=?1 AND label='plan' AND updated_at>=?2", task.id, run.created_at) ?? 0;
  if (!changed) return false;
  const created = db.value<number>(c, "SELECT COUNT(*) FROM tasks WHERE created_by=?1 AND created_at>=?2", task.id, run.created_at) ?? 0;
  return created === 0;
}

/**
 * Whether run `run` of `task` (a `candidate`) changed nothing but the plan: in a worktree, once the checkpoints of its
 * turns are taken, none of them changed a file or moved HEAD. False when that can't be told.
 */
export async function changed_only_plan(state: Shared, task: Task, run: Run): Promise<boolean> {
  if (documents.work_dir(state, task) != null) return true;
  if (checkpoints.own_worktree(state, task) === null) return false;
  const cps = await checkpoints.queued(state, task.id, async (s) => checkpoints.list(s.db(), task.id));
  const turns = cps.filter((cp) => cp.kind === "turn" && cp.run_id === run.id);
  if (!turns.length) return false;
  return turns.every((cp) => {
    const before = cps.find((b) => b.n === cp.before_n);
    return cp.stats != null && cp.stats.files === 0 && before != null && before.head === cp.head;
  });
}

/**
 * The column for the end of run `run_id` of `task` (a `candidate` that would otherwise go to "In review"), once its
 * checkpoints are taken: "Needs attention" if it changed only the plan, else "In review". The task is left as it is if
 * a run has started on it since, or it was moved meanwhile. Calls `in_review` with the task if that's where it went.
 */
export async function settle(state: Shared, task: Task, run: Run, in_review: (t: Task) => void): Promise<void> {
  let waits = false;
  try {
    waits = await changed_only_plan(state, task, run);
  } catch (e) {
    console.error(`task ${task.id}: telling whether its run changed only the plan: ${err_str(e)}`);
  }
  const [status, reason] = waits ? ["needs_attention", PLAN_READY] : ["in_review", null];
  const updated = state.update_task_if(task.id, [["status", status], ["attention_reason", reason]], (c) => {
    if (db.later_run(c, task.id, run.id)) return false;
    const t = db.get_task(c, task.id);
    return t != null && !t.running && t.status === task.status;
  });
  if (updated && status === "in_review") in_review(updated);
}
