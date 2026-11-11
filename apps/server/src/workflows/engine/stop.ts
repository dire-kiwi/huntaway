import { Effect, Exit } from "effect"
import { RunId } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import type { Actor } from "../../platform/Changes.ts"
import { endNodes, mergeLeftReason, releaseReason, waitingColumn } from "../graph.ts"
import { attention } from "./advance.ts"
import { why as whyOf } from "./agentStep.ts"
import { forgetChain, notice, now, withRun, workflowName } from "./core.ts"
import type { Deps } from "./core.ts"

// Stopping runs, and letting go of a task a run held in its column (huntaway's integrations/workflows/engine/stop.ts,
// engine.ts `stop_run`, `release`, and engine/columns.ts `unheld`, `merge_left`).

/**
 * Stops a run in progress, saying `why`; its agent steps' threads stop. With `moveOn`, a task it held moves on
 * (`WorkflowRunSettled`): not when its agent has started again, as the task is that run's now. Whether it was going.
 */
export const stopRun = Effect.fnUntraced(function* (d: Deps, runId: string, why: string, moveOn = true) {
  const stopped = yield* withRun(d, runId, (run) =>
    Effect.gen(function* () {
      if (run.state !== "running") return [run, null] as const
      const at = yield* now
      const ended = endNodes(run, why, at)
      return [{ ...ended.run, state: "stopped" as const, detail: why, finished_at: at, updated_at: at }, ended] as const
    }),
  )
  if (stopped === null) return false
  yield* forgetChain(d, runId)
  for (const t of stopped.threads) yield* d.runs.stop(t)
  if (moveOn) yield* d.changes.offer({ _tag: "WorkflowRunSettled", run: runId, task: stopped.run.task_id, why: null })
  return true
})

/** Stops the task's runs in progress (but those waiting at a column, with `keepWaiting`). Whether any was. */
export const stopAll = Effect.fnUntraced(function* (d: Deps, task: TaskId, why: string, moveOn: boolean, keepWaiting: boolean) {
  let any = false
  for (const r of yield* d.store.running(task)) {
    if (keepWaiting && waitingColumn(r) !== null) continue
    any = (yield* stopRun(d, r.id, why, moveOn)) || any
  }
  return any
})

/** Moves the task as the board, for a run; a refusal is said in its thread. */
const moveFor = Effect.fnUntraced(function* (d: Deps, task: TaskId, status: "in_review" | "needs_attention", by: Actor, what: string) {
  const moved = yield* Effect.exit(d.tasks.update(task, { status }, by))
  if (Exit.isFailure(moved)) yield* notice(d, task, "warning", what, whyOf(moved.cause))
  return Exit.isSuccess(moved)
})

/** Whether the task is idle in `status`: not running, waiting or merging, and its agent not working. */
const idleIn = Effect.fnUntraced(function* (d: Deps, task: TaskId, status: string) {
  const t = yield* d.taskRepo.get(task)
  if (t === null || t.status !== status || t.running || t.waiting || t.merging) return null
  return (yield* d.runs.isRunning(task)) ? null : t
})

/**
 * The task was held in its column for a run that didn't start (or had ended): unless something else has it (a run that
 * holds it, its agent working again), it goes to In review, as it would have without the workflow.
 */
export const unheld = Effect.fnUntraced(function* (d: Deps, task: TaskId) {
  if ((yield* idleIn(d, task, "in_progress")) === null) return
  if ((yield* d.store.running(task)).some((r) => r.source === "finished")) return
  yield* moveFor(d, task, "in_review", { _tag: "Board" }, "Couldn't move the task on after its workflow")
})

/**
 * A task its agent said is merged was left in Ready for merge (out of the merge queue) by the workflow that was to move
 * it to Done: it needs the user, saying why.
 */
export const mergeLeft = Effect.fnUntraced(function* (d: Deps, task: TaskId, reason: string) {
  const t = yield* d.taskRepo.get(task)
  if (t === null || t.status !== "ready_for_merge" || t.merging || t.running || (yield* d.runs.isRunning(task))) return
  if (yield* moveFor(d, task, "needs_attention", { _tag: "Board" }, "Couldn't move the task on after its merge")) yield* attention(d, task, reason)
})

/**
 * A run ended (`WorkflowRunSettled`). One that its task's agent finishing started (HA-276) lets go of the task it held
 * in its column, if it left it there idle: to In review, as it would have gone without the workflow, or to Needs
 * attention saying why when a step failed or the run was stopped. Left alone once it has moved, its agent has started
 * again, or another such run is still going on it. One that was to move a merged task to Done and left it in Ready
 * for merge needs the user.
 */
export const release = Effect.fnUntraced(function* (d: Deps, runId: string, why: string | null) {
  const run = yield* d.store.getRun(runId)
  if (run === null) return
  const name = yield* workflowName(d, run.workflow_id)
  if (run.source === "merged") {
    yield* mergeLeft(d, run.task_id, mergeLeftReason(run, name, why))
    return
  }
  if (run.source !== "finished") return
  if ((yield* idleIn(d, run.task_id, "in_progress")) === null) return
  if (yield* d.reviewRepo.laterRun(run.task_id, run.task_run === null ? null : RunId.make(run.task_run))) return
  if ((yield* d.store.running(run.task_id)).some((r) => r.source === "finished" && r.id !== run.id)) return
  const reason = releaseReason(run, name, why)
  // Its own run's: back in the column whose work this was, which isn't started again (`onStatus`).
  const by: Actor = { _tag: "Workflow", run: run.id, chain: 0 }
  if (reason === null) {
    yield* notice(d, run.task_id, "info", `The workflow "${name}" ended without moving the task, so it goes to In review`)
    yield* moveFor(d, run.task_id, "in_review", by, "Couldn't move the task on after its workflow")
  } else if (yield* moveFor(d, run.task_id, "needs_attention", by, "Couldn't move the task on after its workflow")) {
    yield* attention(d, run.task_id, reason)
  }
})
