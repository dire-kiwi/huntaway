import { Cause, Effect, Exit, FiberSet, Ref } from "effect"
import { NotFound, WorkflowRunId } from "@huntaway/contracts"
import type { Task, TaskId, WorkflowNode, WorkflowNodeRun, WorkflowRunSource } from "@huntaway/contracts"
import type { Change } from "../../platform/Changes.ts"
import { revParse } from "../../review/work.ts"
import { isMerged } from "../../tasks/checks.ts"
import { isHandoff } from "../../tasks/lanes.ts"
import {
  agentWorks,
  columnNode,
  columnText,
  flowEdges,
  graphNode,
  isData,
  mergeFinishThen,
  runNode,
  startNode,
  statusLabel,
  triggerNode,
  waitingColumn,
  withNode,
} from "../graph.ts"
import type { RunState } from "../graph.ts"
import { advance } from "./advance.ts"
import { why, WorkflowRefused } from "./agentStep.ts"
import { columnsOf, workColumn } from "./columns.ts"
import { doneFailed, notice, now, projectOf, record, runsChanged, valueSource, withRun, workflowName } from "./core.ts"
import type { Deps } from "./core.ts"
import { mergeLeft, stopRun, unheld } from "./stop.ts"

// Starting runs (inventory 06, 2.2 "What starts a run"; huntaway's integrations/workflows/engine.ts `on_status`, `start`,
// and engine/columns.ts `on_finished`, `on_merged`, `on_merge_finished`; engine/stop.ts `resume`).

/** How many runs in a row moves may start on a task (counting the first), before the next isn't started. */
export const MAX_CHAIN = 10

/** What a run starts from: the task entering a column node's column, its agent's work there done, its merge, or by hand. */
export interface StartOptions {
  readonly manual: boolean
  readonly on: Exclude<WorkflowRunSource, "manual">
  /** The node to start at (else the column node for what `on` says). */
  readonly at?: string | undefined
  /** How many runs in a row moves have started before this one. */
  readonly chain?: number | undefined
}

const skip = (manual: boolean, reason: string) => (manual ? Effect.fail(WorkflowRefused.conflict(`Can't run the workflow: ${reason}`)) : Effect.succeed(null))

/** Under the task's start lock: checks and records the run. What to do once the lock is let go, or null. */
const startLocked = Effect.fnUntraced(function* (d: Deps, workflowId: string, taskId: TaskId, o: StartOptions) {
  const w = yield* d.store.get(workflowId)
  if (w === null) return yield* new NotFound({ what: "workflow", id: workflowId })
  const task = yield* d.taskRepo.get(taskId)
  if (task === null) return yield* new NotFound({ what: "task", id: taskId })
  if (task.kind !== "task" || task.project_id !== w.project_id) return yield* WorkflowRefused.invalid("a workflow runs only on its own project's tasks")
  const project = yield* projectOf(d, w.project_id)
  if (project === null) return yield* new NotFound({ what: "project", id: w.project_id })
  const { manual, on } = o
  if (project.archived_at !== null) return yield* skip(manual, "the project is archived")
  if (!manual && (!w.enabled || !project.use_workflows)) return null
  const from: WorkflowNode | undefined = manual
    ? (triggerNode(w.graph) ?? columnNode(w.graph, task.status))
    : o.at !== undefined
      ? graphNode(w.graph, o.at)
      : columnNode(w.graph, on === "finished" ? "in_progress" : on === "merged" ? "ready_for_merge" : task.status)
  if (from === undefined) return yield* skip(manual, `it has no start, nor a node for the task's column (${statusLabel(task.status)})`)
  if (!manual) {
    if (from.kind !== "column") return null
    if (on === "status" && from.status !== task.status) return null
    if (on === "finished" && (task.status === "done" || task.merging)) return null
    // Merged: in Done, or still in Ready for merge when its agent said so for the workflow to move it.
    if (on === "merged" && task.status !== "done" && !(task.status === "ready_for_merge" && !task.merging)) return null
  }
  // Waiting at a column whose prompt the agent is sent, for that work to be done.
  const waits = !manual && on === "status" && agentWorks(from, w.graph)
  // A column with nothing after it is only where lines end: a run would hide the last one's output in the task's tabs.
  if (!manual && !waits && on !== "finished" && !flowEdges(w.graph).some((e) => e.from === from.id)) return null
  // Read before the check that it isn't running, so a run that starts in between counts as later (below).
  const taskRun = yield* d.reviewRepo.latestRun(task.id)
  // A merge ends while the agent that merged it is still going.
  if (on !== "merged" && (yield* d.runs.isRunning(task.id))) return yield* skip(manual, "the task's agent is still working")
  const previous = yield* d.store.latestRun(w.id, task.id)
  const same = (yield* d.store.running(task.id)).some((r) => r.workflow_id === w.id && r.nodes[from.id]?.start === true)
  if (same) return yield* skip(manual, "it's already running on this task")
  // Once for each time the agent finishes (a restart settles a plan task's column again), and once for each merge.
  if (!manual && (on === "finished" || on === "merged") && previous !== null && previous.source === on && previous.task_run === taskRun) return null
  const dir = task.worktree_state === "ready" ? task.worktree_path : null
  const head = dir === null ? null : yield* revParse(d.git, dir, "HEAD")
  const at = yield* now
  const nodes: Record<string, WorkflowNodeRun> = {}
  for (const n of w.graph.nodes) {
    // Data nodes have no part in a run: they're read.
    if (isData(n)) continue
    if (n.id !== from.id) nodes[n.id] = { state: "pending" }
    else if (waits) nodes[n.id] = { state: "running", start: true, started_at: at }
    else nodes[n.id] = { state: "done", port: n.kind === "trigger" ? "out" : "done", start: true, started_at: at, finished_at: at }
  }
  const run: RunState = {
    id: WorkflowRunId.make(yield* d.newId),
    workflow_id: w.id,
    task_id: task.id,
    source: manual ? "manual" : on,
    state: "running",
    head,
    task_run: taskRun,
    graph: w.graph,
    nodes,
    rounds: manual ? {} : (previous?.rounds ?? {}),
    detail: null,
    created_at: at,
    updated_at: at,
    finished_at: null,
  }
  // The agent may have started again while git was read: `supersede` found no run to stop then.
  if (on !== "merged" && ((yield* d.reviewRepo.laterRun(task.id, taskRun)) || (yield* d.runs.isRunning(task.id)))) {
    return yield* skip(manual, "the task's agent is working again")
  }
  yield* d.db.tx(
    Effect.gen(function* () {
      yield* d.store.insertRun(run)
      yield* runsChanged(d, task.id)
    }),
  )
  const chain = o.chain ?? 0
  if (chain > 0) yield* Ref.update(d.chains, (m) => new Map(m).set(run.id, chain))
  yield* notice(d, task.id, "info", `Running the workflow "${w.name}"`)
  return { run, task, w, project, from, waits }
})

/**
 * Runs workflow `workflowId` on task `taskId`. `manual` (the user, or an agent, asked for it) runs it whether or not
 * it's on or the task is in its column, with fresh rounds, from its start (or else its node for the task's column), and
 * says why when it can't (`WorkflowRefused`). Otherwise it starts at node `at`, for what `on` says happened. The run as
 * it is once its first steps started, or null when there was nothing to do.
 */
export const start = Effect.fnUntraced(function* (d: Deps, workflowId: string, taskId: TaskId, o: StartOptions) {
  const started = yield* d.locks.withLock(["workflows", taskId])(startLocked(d, workflowId, taskId, o))
  if (started === null) return null
  const { run, task, w, project, from, waits } = started
  if (waits && from.kind === "column") {
    const text = columnText(yield* valueSource(d, w, task, project, run), from, "")
    const sent = yield* Effect.exit(d.runs.send(task.id, { text, source: "board", auto: true }))
    if (Exit.isFailure(sent)) yield* record(d, run.id, from.id, doneFailed(`couldn't send the agent the column's prompt: ${why(sent.cause)}`))
  }
  yield* advance(d, run.id)
  return yield* d.store.getRun(run.id)
})

/** `effect` in the background, so the reactor goes on; what fails is said on the task. */
export const inBackground = <A, E>(d: Deps, task: TaskId, what: string, effect: Effect.Effect<A, E>) =>
  FiberSet.run(
    d.background,
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.andThen(Effect.logWarning(`task=${task} ${what}`, cause), notice(d, task, "warning", what, why(cause))),
      ),
    ),
  ).pipe(Effect.asVoid)

/** Starts a workflow at a column in the background, saying on the task if it couldn't. */
const startLater = (d: Deps, w: { readonly id: string; readonly name: string }, task: TaskId, o: StartOptions) =>
  inBackground(d, task, `Couldn't run the workflow "${w.name}"`, start(d, w.id, task, o))

/** The task was merged: the project's workflows with a node for Ready for merge go on from there. */
const onMerged = Effect.fnUntraced(function* (d: Deps, task: Task) {
  if (task.kind !== "task" || task.project_id === null) return
  for (const [w, n] of yield* columnsOf(d, task.project_id, "ready_for_merge")) yield* startLater(d, w, task.id, { manual: false, on: "merged", at: n.id })
})

/** Whether a move a run made back into the column it started at, once it ended, would start that column again. */
const quiet = Effect.fnUntraced(function* (d: Deps, cause: Change & { readonly _tag: "TaskChanged" }, workflow: string, node: string) {
  if (cause.cause._tag !== "Workflow") return false
  const run = yield* d.store.getRun(cause.cause.run)
  return run !== null && run.state !== "running" && run.workflow_id === workflow && startNode(run)?.id === node
})

/**
 * The task entered the column it's in (`TaskChanged`, a status move): the project's workflows start at their nodes for
 * that column, in the background. In In progress and Ready for merge they start when the agent's work there is done
 * (`onFinished`, `onMerged`), not now. A run waiting for the work of a column the task has left is over. A move made by
 * a run's step continues its chain of runs: two workflows moving a task into each other's columns stop after `MAX_CHAIN`.
 */
export const onStatus = Effect.fnUntraced(function* (d: Deps, change: Change & { readonly _tag: "TaskChanged" }) {
  const task = change.after
  if (task === null || task.kind !== "task" || task.project_id === null || change.before?.status === task.status) return
  const chain = change.cause._tag === "Workflow" ? change.cause.chain + 1 : 0
  // Its agent's work moves it to In progress, and a question it asks to Needs attention, without leaving the column it works for.
  if (task.status !== "in_progress" && task.status !== "needs_attention") {
    for (const r of yield* d.store.running(task.id)) {
      const n = waitingColumn(r)
      if (n !== null && n.status !== task.status) yield* stopRun(d, r.id, `Stopped because the task left ${statusLabel(n.status)}.`)
    }
  }
  if (task.status === "in_progress" || task.status === "ready_for_merge") return
  if (isMerged(task)) yield* onMerged(d, task)
  const due: Array<readonly [{ readonly id: string; readonly name: string }, string]> = []
  for (const [w, n] of yield* columnsOf(d, task.project_id, task.status)) if (!(yield* quiet(d, change, w.id, n.id))) due.push([w, n.id])
  if (due.length > 0 && chain >= MAX_CHAIN) {
    const names = due.map(([w]) => `"${w.name}"`).join(", ")
    yield* notice(
      d,
      task.id,
      "warning",
      `Didn't run ${due.length === 1 ? "the workflow" : "the workflows"} ${names}: workflows have moved the task ${chain} times in a row`,
      "Their steps may be moving the task from column to column and back. Moving the task yourself (or running a workflow by hand) starts again.",
    )
    return
  }
  for (const [w, n] of due) yield* startLater(d, w, task.id, { manual: false, on: "status", at: n, chain })
})

/** The task's agent's work for `due` is done (the task held in its column for it): its run goes on from there. */
export const onFinished = Effect.fnUntraced(function* (
  d: Deps,
  taskId: TaskId,
  due: { readonly workflow_id: string; readonly node: string; readonly run_id: string | null },
) {
  if (due.run_id === null) {
    const name = yield* workflowName(d, due.workflow_id)
    const started = start(d, due.workflow_id, taskId, { manual: false, on: "finished", at: due.node }).pipe(
      Effect.flatMap((run) => (run === null ? unheld(d, taskId) : Effect.void)),
      Effect.catchCause((cause) =>
        Effect.andThen(notice(d, taskId, "warning", `Couldn't run the workflow "${name !== "" ? name : due.workflow_id}"`, why(cause)), unheld(d, taskId)),
      ),
    )
    yield* inBackground(d, taskId, "Couldn't move the task on after its workflow", started)
    return
  }
  const latest = yield* d.reviewRepo.latestRun(taskId)
  const runId = due.run_id
  const going = yield* withRun(d, runId, (run) =>
    Effect.gen(function* () {
      if (run.state !== "running" || runNode(run, due.node).state !== "running") return [run, false] as const
      const at = yield* now
      // It holds the task now, as a run that its agent finishing started does (`release`), from the run that ended.
      const next = withNode({ ...run, source: "finished" as const, task_run: latest, updated_at: at }, due.node, (r) => ({
        ...r,
        state: "done",
        port: "done",
        finished_at: at,
      }))
      return [next, true] as const
    }),
  )
  if (going !== true) {
    yield* unheld(d, taskId)
    return
  }
  yield* inBackground(d, taskId, "Couldn't go on with the workflow", advance(d, runId))
})

/** The project's workflow whose Ready for merge node goes on to Done once the merge is done. */
export const mergesToDone = Effect.fnUntraced(function* (d: Deps, task: Pick<Task, "kind" | "project_id">) {
  const found = yield* workColumn(d, task, "ready_for_merge")
  return found !== null && mergeFinishThen(found[0].graph, found[1]) !== null ? found : null
})

/** The merging agent said the task is merged and its run has ended: the workflow goes on from Ready for merge, to Done. */
export const onMergeFinished = Effect.fnUntraced(function* (d: Deps, taskId: TaskId) {
  const task = yield* d.taskRepo.get(taskId)
  if (task === null) return
  const found = yield* mergesToDone(d, task)
  // Its workflow was turned off or changed meanwhile (over a restart, say): nothing will move it, so the user does.
  if (found === null) {
    yield* mergeLeft(d, taskId, "The agent said the task is merged, but no workflow that's on moves it to Done now")
    return
  }
  const [w, n] = found
  const started = start(d, w.id, taskId, { manual: false, on: "merged", at: n.id }).pipe(
    Effect.flatMap((run) =>
      run === null ? mergeLeft(d, taskId, `The workflow "${w.name}" didn't start after the merge, so it didn't move the task to Done`) : Effect.void,
    ),
    Effect.catchCause((cause) => mergeLeft(d, taskId, `Couldn't run the workflow "${w.name}" after the merge: ${why(cause).split("\n")[0] ?? ""}`)),
  )
  yield* inBackground(d, taskId, "Couldn't move the task on after its merge", started)
})

/**
 * On start (after the runs are followed again): steps that were running on the board itself when the server stopped
 * failed, and the runs go on from there; so did agent steps whose agent isn't running. A merge its agent said was done,
 * whose run to Done the server stopped before starting, starts now.
 */
export const resume = Effect.fnUntraced(function* (d: Deps) {
  const running = yield* d.store.running(null)
  for (const run of running) {
    const failed: Array<string> = []
    for (const n of run.graph.nodes) {
      if (isData(n)) continue
      const r = runNode(run, n.id)
      if (r.state !== "running") continue
      // Agents carry on over a restart, and their runs' ends end their steps, as the task's agent's do a column's.
      if (n.kind === "agent" && r.thread_id !== undefined && (yield* d.runs.isRunning(r.thread_id))) continue
      if (n.kind === "column" && r.start === true) continue
      failed.push(n.id)
    }
    if (failed.length === 0) continue
    yield* withRun(d, run.id, (current) =>
      Effect.gen(function* () {
        const at = yield* now
        let next = current
        for (const id of failed) {
          const n = graphNode(current.graph, id)
          if (runNode(next, id).state !== "running") continue
          next = withNode(next, id, (r) => ({
            ...r,
            state: "failed",
            port: "failed",
            text: n?.kind === "agent" ? "Interrupted: the server stopped before this step's agent started." : "Interrupted: the server stopped while this ran.",
            finished_at: at,
          }))
        }
        return [{ ...next, updated_at: at }, null] as const
      }),
    )
  }
  for (const run of running) yield* inBackground(d, run.task_id, "Couldn't go on with the workflow", advance(d, run.id))
  // A merge its agent said was done, whose workflow run to Done the server stopped before starting.
  for (const p of yield* d.taskRepo.projects) {
    const finished = yield* d.taskRepo.finishedLast(p.id)
    if (finished.size === 0) continue
    for (const t of yield* d.taskRepo.projectTasks(p.id)) {
      if (isHandoff(t, finished) && !running.some((r) => r.task_id === t.id && r.source === "merged")) yield* onMergeFinished(d, t.id)
    }
  }
})
