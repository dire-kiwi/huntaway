import { Context, Effect, FiberSet, Layer, Ref } from "effect"
import { SecureRandom } from "effect/crypto"
import { NotFound } from "@huntaway/contracts"
import type { Task, TaskId, TaskWorkflowRuns, WorkflowId, WorkflowRun } from "@huntaway/contracts"
import { ContextMeter } from "../agents/ContextMeter.ts"
import { WorkflowFacts } from "../agents/WorkflowFacts.ts"
import type { WorkflowFactsReader } from "../agents/WorkflowFacts.ts"
import { Git } from "../git/Git.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { Gh } from "../github/Gh.ts"
import { Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import type { Submitted } from "../review/model.ts"
import { ReviewRepo } from "../review/ReviewRepo.ts"
import { Reviews } from "../review/Reviews.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import type { Outcome } from "../runs/Run.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { advance } from "./engine/advance.ts"
import { stepEnded, submit, WorkflowRefused } from "./engine/agentStep.ts"
import { notice, runJson } from "./engine/core.ts"
import type { Deps } from "./engine/core.ts"
import { factsReader } from "./engine/facts.ts"
import { inBackground, onFinished, onMergeFinished, onStatus, resume, start } from "./engine/start.ts"
import { release, stopAll, stopRun } from "./engine/stop.ts"
import { waitingColumn } from "./graph.ts"
import type { RunState } from "./graph.ts"
import { WorkflowStore } from "./WorkflowStore.ts"

// Running a project's workflows on its tasks (docs/plan/06-server.md, Workflows; inventory 06, 2.2; huntaway's
// integrations/workflows/engine.ts and engine/*): starting a run, advancing it node by node, its agent steps, its end,
// stopping it, and picking runs up at startup. The graph's semantics are `graph.ts`'s pure functions; a run's state is
// one row rewritten under the run's lock. The engine never moves a task by itself: it calls `Tasks` and the reactor
// carries the consequences (a move into a column starts that column's workflows through `onStatus`), which takes the
// place of the old `MOVING` and `QUIET` (a move's cause is the run that made it) and keeps `CHAIN` as a count on it.

export { WorkflowRefused } from "./engine/agentStep.ts"

export interface WorkflowEngineShape {
  /** Runs a workflow on one of its project's tasks now (`workflows.run`, `run_workflow`): the run once its first steps started. */
  readonly run: (workflow: WorkflowId, task: TaskId) => Effect.Effect<WorkflowRun, WorkflowRefused | NotFound>
  /** The reactor's step for a task's status move: runs waiting at a column it left stop, its new column's start. */
  readonly onStatus: (change: Change & { readonly _tag: "TaskChanged" }) => Effect.Effect<void>
  /** The reactor's `WorkflowWorkDone`: the column that held the task goes on, or its workflow moves the merged task to Done. */
  readonly workDone: (change: Change & { readonly _tag: "WorkflowWorkDone" }) => Effect.Effect<void>
  /** The reactor's `WorkflowRunSettled`: a task a run held in its column moves on. */
  readonly release: (run: string, why: string | null) => Effect.Effect<void>
  /** An agent step's thread's run ended (the reactor's `ReviewFinished` for a workflow thread): its step's output, and on. */
  readonly stepEnded: (thread: TaskId, run: string, outcome: Outcome, attention: string | null) => Effect.Effect<void>
  /** `submit_review` from a workflow's verdict step: recorded while it runs, acted on when its run ends. */
  readonly submit: (thread: Task, run: string, args: Submitted) => Effect.Effect<{ readonly ok: boolean; readonly note: string }, WorkflowRefused>
  /** The task's agent started working again: its runs in progress are out of date, but those waiting for its work at a column. */
  readonly supersede: (task: TaskId) => Effect.Effect<void>
  /** The user's Stop: the task's agent, its review and summaries (`Reviews.stopTask`), and its workflow runs. */
  readonly stopTask: (task: TaskId) => Effect.Effect<{ readonly stopped: boolean }>
  /** Stops a run in progress (`workflows.stopRun`). Whether it was going. */
  readonly stopRun: (run: string, why: string) => Effect.Effect<boolean, NotFound>
  /** A workflow turned off: its runs waiting for a column's work stop. */
  readonly stopWaiting: (workflow: WorkflowId, why: string) => Effect.Effect<void>
  /** A workflow deleted: its runs in progress stop. The tasks it had runs on. */
  readonly stopWorkflow: (workflow: WorkflowId, why: string) => Effect.Effect<ReadonlyArray<TaskId>>
  /** The latest run of each workflow on the task (and the earlier ones its tabs show), and its project's workflows. */
  readonly runsOfTask: (task: TaskId) => Effect.Effect<TaskWorkflowRuns, NotFound>
  /** The task's latest runs, as `latestRuns` without the earlier ones, for `get_task`. */
  readonly latestRuns: (task: TaskId) => Effect.Effect<ReadonlyArray<WorkflowRun>>
  /** Recovery: runs a restart interrupted go on. */
  readonly resume: Effect.Effect<void>
  /** Waits until what the engine does in the background (starts, advances) has finished (tests). */
  readonly idle: Effect.Effect<void>
  /** What the prompts, a run's end and the merge queue read of a task's workflows (`registered` with `WorkflowFacts`). */
  readonly facts: WorkflowFactsReader
}

/** Whether node `id` ran in run `r` (not pending nor skipped). */
const ran = (r: RunState, id: string) => {
  const st = r.nodes[id]?.state
  return st !== undefined && st !== "pending" && st !== "skipped"
}

/**
 * The latest run of each workflow on the task, newest first. With `steps`, also the latest earlier run in which each of
 * its agent steps ran, where the latest skipped it, so the task's tabs show each step's last output.
 */
export const latestRuns = (all: ReadonlyArray<RunState>, steps: boolean): ReadonlyArray<RunState> => {
  const out: Array<RunState> = []
  for (const latest of all) {
    if (out.some((r) => r.workflow_id === latest.workflow_id)) continue
    out.push(latest)
    if (!steps) continue
    for (const n of latest.graph.nodes) {
      if (n.kind !== "agent" || ran(latest, n.id)) continue
      const earlier = all.find((r) => r.workflow_id === latest.workflow_id && r.id !== latest.id && ran(r, n.id))
      if (earlier !== undefined && !out.includes(earlier)) out.push(earlier)
    }
  }
  return out.toSorted((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : all.indexOf(a) - all.indexOf(b)))
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()("huntaway-server/workflows/WorkflowEngine") {
  static readonly layer = Layer.effect(
    WorkflowEngine,
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom
      const store = yield* WorkflowStore
      const reviews = yield* Reviews
      const d: Deps = {
        db: yield* Db,
        locks: yield* KeyedLock,
        store,
        tasks: yield* Tasks,
        taskRepo: yield* TaskRepo,
        projects: yield* ProjectRepo,
        profiles: yield* ProfileRepo,
        configs: yield* AgentConfigRepo,
        runs: yield* Runs,
        reviewRepo: yield* ReviewRepo,
        threads: yield* Threads,
        readers: yield* ThreadReaders,
        events: yield* Events,
        changes: yield* Changes,
        git: yield* Git,
        taskBase: yield* TaskBase,
        gh: yield* Gh,
        meter: yield* ContextMeter,
        launchFacts: yield* LaunchFacts,
        config: yield* ServerConfig,
        newId: random.uuidV4(),
        chains: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
        background: yield* FiberSet.make(),
      }

      const named = Effect.fnUntraced(function* (run: RunState) {
        return runJson(run, (yield* store.get(run.workflow_id))?.name ?? null)
      })

      const run = Effect.fn("WorkflowEngine.run")(function* (workflow: WorkflowId, task: TaskId) {
        const r = yield* start(d, workflow, task, { manual: true, on: "status" })
        if (r === null) return yield* WorkflowRefused.conflict("the workflow didn't run")
        return yield* named(r)
      })

      const stopTask = Effect.fn("WorkflowEngine.stopTask")(function* (task: TaskId) {
        const stopped = yield* reviews.stopTask(task)
        const workflows = yield* stopAll(d, task, "Stopped by the user.", true, false)
        if (workflows) yield* notice(d, task, "warning", "Workflow stopped")
        return { stopped: stopped.stopped || workflows }
      })

      return WorkflowEngine.of({
        run,
        onStatus: (change) => onStatus(d, change).pipe(Effect.withSpan("WorkflowEngine.onStatus")),
        workDone: Effect.fn("WorkflowEngine.workDone")(function* (change) {
          if (change.due !== null) yield* onFinished(d, change.task, change.due)
          if (change.mergeFinished) yield* onMergeFinished(d, change.task)
        }),
        release: Effect.fn("WorkflowEngine.release")(function* (r, why) {
          yield* release(d, r, why)
        }),
        stepEnded: Effect.fn("WorkflowEngine.stepEnded")(function* (thread, r, outcome, attention) {
          const id = yield* stepEnded(d, thread, r, outcome, attention)
          if (id === null) return
          const t = yield* d.taskRepo.get(thread)
          yield* inBackground(d, t?.parent_id ?? thread, "Couldn't go on with the workflow", advance(d, id))
        }),
        submit: (thread, r, args) => submit(d, thread, r, args).pipe(Effect.withSpan("WorkflowEngine.submit")),
        supersede: Effect.fn("WorkflowEngine.supersede")(function* (task) {
          yield* stopAll(d, task, "Stopped because the agent started working on the task again.", false, true)
        }),
        stopTask,
        stopRun: Effect.fn("WorkflowEngine.stopRun")(function* (r, why) {
          if ((yield* store.getRun(r)) === null) return yield* new NotFound({ what: "workflow run", id: r })
          return yield* stopRun(d, r, why)
        }),
        stopWaiting: Effect.fn("WorkflowEngine.stopWaiting")(function* (workflow, why) {
          for (const r of yield* store.running(null)) if (r.workflow_id === workflow && waitingColumn(r) !== null) yield* stopRun(d, r.id, why)
        }),
        stopWorkflow: Effect.fn("WorkflowEngine.stopWorkflow")(function* (workflow, why) {
          for (const r of yield* store.running(null)) if (r.workflow_id === workflow) yield* stopRun(d, r.id, why)
          return yield* store.tasksOf(workflow)
        }),
        runsOfTask: Effect.fn("WorkflowEngine.runsOfTask")(function* (task) {
          const t = yield* d.taskRepo.get(task)
          if (t === null) return yield* new NotFound({ what: "task", id: task })
          const runs = yield* Effect.forEach(latestRuns(yield* store.runsOfTask(task), true), named, { concurrency: 1 })
          const workflows =
            t.project_id !== null && t.kind === "task" ? (yield* store.list(t.project_id)).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled })) : []
          return { runs, workflows }
        }),
        latestRuns: (task) => Effect.flatMap(store.runsOfTask(task), (all) => Effect.forEach(latestRuns(all, false), named, { concurrency: 1 })),
        resume: resume(d).pipe(Effect.withSpan("WorkflowEngine.resume")),
        idle: FiberSet.awaitEmpty(d.background),
        facts: factsReader(d),
      })
    }),
  )

  /** The engine's reader of what the prompts, a run's end and the merge queue need to know of a task's workflows. */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const facts = yield* WorkflowFacts
      yield* facts.register((yield* WorkflowEngine).facts)
    }),
  )
}
