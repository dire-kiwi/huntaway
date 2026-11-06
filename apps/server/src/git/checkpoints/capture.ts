// Port of server/src/git/checkpoints/capture.rs: taking checkpoints: before each run and after each turn, and dropping
// a task's.
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { AppState } from "../../state.ts";
import { err_str, now } from "../../util.ts";
import { enqueue, latest, queued, ref_prefix, type Stats } from "../checkpoints.ts";
import { stats } from "./changed.ts";
import { keep, own_worktree, prune, run_ok, snapshot, worktree_top } from "./git.ts";

/** Whether a run of `task` takes checkpoints. */
function wanted(state: AppState, task: Task, run: Run): boolean {
  return run.kind !== "compact" && own_worktree(state, task) !== null;
}

/** Before a run of `task` starts (its worktree set up): a checkpoint, if the files or HEAD have changed since the last one. */
export async function before_run(state: AppState, task: Task, run: Run): Promise<void> {
  if (!wanted(state, task, run)) return;
  const [task_id, run_id, session] = [task.id, run.id, task.session_id ?? null];
  try {
    await queued(state, task.id, async (s) => {
      const top = await worktree_top(s, task_id);
      if (top === null) throw new Error("no worktree");
      const last = latest(s.db(), task_id);
      const snap = await snapshot(top, last);
      if (last && last.tree === snap.tree && last.head === snap.head) return;
      await keep(s, task_id, top, snap, (n) => ({
        n,
        kind: "start",
        sha: snap.sha,
        tree: snap.tree,
        head: snap.head,
        before_n: null,
        run_id,
        turn: null,
        message_id: null,
        status: null,
        session,
        agent_at: null,
        stats: null,
        stale: 0,
        created_at: now(),
      }));
      await prune(s, task_id, top);
    });
  } catch (e) {
    console.warn(`task ${task.id}: couldn't take a checkpoint before the run: ${err_str(e)}`);
  }
}

/** One of the agent's turns in run `run_id` ended (`status`: done, stopped or failed): a checkpoint of what it left, taken in the background. */
export function after_turn(state: AppState, run_id: string, status: string): void {
  let run: Run, task: Task;
  try {
    const c = state.db();
    const r = db.get_run(c, run_id);
    if (!r) return;
    const t = db.get_task(c, r.task_id);
    if (!t) return;
    [run, task] = [r, t];
  } catch (e) {
    console.warn(`run ${run_id}: couldn't look up a run for its checkpoint: ${err_str(e)}`);
    return;
  }
  // A turn the agent starts by itself (a background task finishing, say) didn't start with a message.
  try {
    db.run(state.db(), "UPDATE runs SET turn_message_id=NULL WHERE id=?1", run_id);
  } catch {}
  if (!wanted(state, task, run)) return;
  const task_id = task.id;
  enqueue(state, task.id, async (s) => {
    try {
      const top = await worktree_top(s, task_id);
      if (top === null) throw new Error("no worktree");
      const before = latest(s.db(), task_id);
      const snap = await snapshot(top, before);
      let st: Stats | null = null;
      if (before) {
        try {
          st = await stats(top, before, snap);
        } catch (e) {
          console.warn(`task ${task_id}: couldn't count a turn's changes: ${err_str(e)}`);
        }
      }
      const turn = Number(db.value(s.db(), "SELECT COALESCE(MAX(turn), 0) + 1 FROM checkpoints WHERE task_id=?1", task_id));
      await keep(s, task_id, top, snap, (n) => ({
        n,
        kind: "turn",
        sha: snap.sha,
        tree: snap.tree,
        head: snap.head,
        before_n: before ? before.n : null,
        run_id: run.id,
        turn,
        message_id: run.turn_message_id ?? null,
        status,
        session: task.session_id ?? null,
        agent_at: run.agent_at ?? null,
        stats: st,
        stale: 0,
        created_at: now(),
      }));
      await prune(s, task_id, top);
      s.emit({ type: "checkpoints", task_id });
    } catch (e) {
      console.warn(`task ${task_id}: couldn't take a checkpoint after a turn: ${err_str(e)}`);
    }
  });
}

/** Drop the task's checkpoints (its worktree at `dir` is going), after any being taken. */
export async function forget(state: AppState, task_id: string, dir: string): Promise<void> {
  try {
    await queued(state, task_id, async (s) => {
      const refs = await run_ok(dir, ["for-each-ref", "--format=delete %(refname)", ref_prefix(task_id)]);
      if (refs.stdout.length) await run_ok(dir, ["update-ref", "--stdin"], {}, refs.stdout);
      db.run(s.db(), "DELETE FROM checkpoints WHERE task_id=?1", task_id);
    });
  } catch (e) {
    console.warn(`task ${task_id}: couldn't drop the task's checkpoints: ${err_str(e)}`);
  }
}
