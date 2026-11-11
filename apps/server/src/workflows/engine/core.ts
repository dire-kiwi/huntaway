import { Context, Effect, Option, Random, Ref } from "effect"
import type { FiberSet } from "effect"
import type { Project, Task, TaskId, Timestamp, WorkflowNodeRun, WorkflowRun } from "@huntaway/contracts"
import type { ContextMeterShape } from "../../agents/ContextMeter.ts"
import type { GitShape } from "../../git/Git.ts"
import type { TaskBaseShape } from "../../git/TaskBase.ts"
import type { GhShape } from "../../github/Gh.ts"
import type { ChangesShape } from "../../platform/Changes.ts"
import { nowTimestamp } from "../../platform/columns.ts"
import type { DbShape } from "../../platform/Db.ts"
import type { EventsShape } from "../../platform/Events.ts"
import type { KeyedLockShape } from "../../platform/KeyedLock.ts"
import type { ServerConfig } from "../../platform/ServerConfig.ts"
import type { AgentConfigRepoShape } from "../../profiles/AgentConfigRepo.ts"
import type { ProfileRepoShape } from "../../profiles/ProfileRepo.ts"
import type { ProjectRepoShape } from "../../projects/ProjectRepo.ts"
import { projectMerge, projectReview, projectStart } from "../../agents/prompts/project.ts"
import type { ReviewRepoShape } from "../../review/ReviewRepo.ts"
import type { LaunchFactsShape } from "../../runs/LaunchFacts.ts"
import type { RunsShape } from "../../runs/Runs.ts"
import type { TaskRepoShape } from "../../tasks/TaskRepo.ts"
import type { TasksShape } from "../../tasks/Tasks.ts"
import type { ThreadReadersShape } from "../../threads/ThreadReaders.ts"
import type { ThreadsShape } from "../../threads/Threads.ts"
import { graphNode, runNode, withNode, dropPort, dropText } from "../graph.ts"
import type { RunState, ValueSource } from "../graph.ts"
import type { WorkflowStoreShape } from "../WorkflowStore.ts"

// What the engine's parts share (docs/plan/06-server.md, Workflows): the services it works with, and changing a run's
// state, which is one row rewritten under the run's lock (`withRun`), so steps ending at once queue rather than write
// over each other.

/**
 * The random numbers (in [0, 1)) A/B tests pick their paths by: `Random.next` unless a test gives its own (the old
 * `engine_testing.random`).
 */
export const SplitRandom = Context.Reference<Effect.Effect<number>>("huntaway-server/workflows/engine/core/SplitRandom", {
  defaultValue: () => Random.next,
})

/** Where `open_pr` pushes and opens pull requests, in place of the task's remotes (tests: the old `engine_testing.GITHUB`). */
export const OpenPrTarget = Context.Reference<{ readonly remote: string; readonly repo: string } | null>("huntaway-server/workflows/engine/core/OpenPrTarget", {
  defaultValue: () => null,
})

/** The services the engine's parts work with, taken once when its layer is built. */
export interface Deps {
  readonly db: DbShape
  readonly locks: KeyedLockShape
  readonly store: WorkflowStoreShape
  readonly tasks: TasksShape
  readonly taskRepo: TaskRepoShape
  readonly projects: ProjectRepoShape
  readonly profiles: ProfileRepoShape
  readonly configs: AgentConfigRepoShape
  readonly runs: RunsShape
  readonly reviewRepo: ReviewRepoShape
  readonly threads: ThreadsShape
  readonly readers: ThreadReadersShape
  readonly events: EventsShape
  readonly changes: ChangesShape
  readonly git: GitShape
  readonly taskBase: TaskBaseShape
  readonly gh: GhShape
  readonly meter: ContextMeterShape
  readonly launchFacts: LaunchFactsShape
  readonly config: ServerConfig["Service"]
  /** A new id (a uuid). */
  readonly newId: Effect.Effect<string>
  /** Runs started by another run's move, by id: how many runs in a row (each started by the one before's move) led to them. */
  readonly chains: Ref.Ref<ReadonlyMap<string, number>>
  /** Starts, advances and releases going on in the background, so the reactor isn't held up by a push. */
  readonly background: FiberSet.FiberSet
}

/** What a node did. `port` null: it ended without one (a column, whose outcome is the next run's; a condition's error). */
export interface Done {
  readonly state: WorkflowNodeRun["state"]
  readonly port: string | null
  readonly text: string | null
}

export const donePort = (port: string, text: string | null = null): Done => ({ state: "done", port, text })
export const doneFailed = (why: string): Done => ({ state: "failed", port: "failed", text: why })
/** A node that ended without an outcome: a column, whose outcome is the next run's. */
export const doneNone: Done = { state: "done", port: null, text: null }

/** Says `text` in the task's thread (the old `add_event`); a task that's gone is left be. */
export const notice = (d: Deps, task: TaskId, level: "info" | "warning" | "error", text: string, detail?: string | null) =>
  d.threads.notice(task, level, text, detail ?? undefined).pipe(Effect.ignore)

/** The task's workflow runs changed: the board reads them again. */
export const runsChanged = (d: Deps, task: TaskId) => d.events.emit({ type: "workflow_runs_changed", task_id: task })

/** A workflow's name, "" once it's deleted. */
export const workflowName = (d: Deps, id: string) => Effect.map(d.store.get(id), (w) => w?.name ?? "")

/**
 * Changes run `id` under its lock, in one transaction: `f` sees it as it is and returns it as it's to be (saved, with
 * `workflow_runs_changed`, when it's another value) and what to give back. Null when the run is gone.
 */
export const withRun = <A, E, R>(d: Deps, id: string, f: (run: RunState) => Effect.Effect<readonly [RunState, A], E, R>): Effect.Effect<A | null, E, R> =>
  d.locks.withLock(["workflowRun", id])(
    d.db.tx(
      Effect.gen(function* () {
        const run = yield* d.store.getRun(id)
        if (run === null) return null
        const [next, out] = yield* f(run)
        if (next !== run) {
          yield* d.store.saveRun(next)
          yield* runsChanged(d, next.task_id)
        }
        return out
      }),
    ),
  )

/** Records what node `id` did, if the run is still going and the node still running. The run as saved, or null. */
export const record = (d: Deps, runId: string, id: string, done: Done) =>
  withRun(d, runId, (run) =>
    Effect.gen(function* () {
      if (run.state !== "running" || runNode(run, id).state !== "running") return [run, null] as const
      const at = yield* nowTimestamp
      const next = withNode({ ...run, updated_at: at }, id, (r) => {
        const ported = done.port !== null ? { ...r, port: done.port } : dropPort(r)
        return { ...(done.text !== null ? { ...ported, text: done.text } : ported), state: done.state, finished_at: at }
      })
      return [next, next] as const
    }),
  )

/** `r` with its text dropped (for a step whose verdict has no summary). */
export const textless = dropText

/** The run as the wire has it, with its workflow's name (null once deleted). */
export const runJson = (run: RunState, name: string | null): WorkflowRun => {
  const { task_run: _taskRun, ...rest } = run
  return { ...rest, workflow_name: name }
}

export const projectOf = (d: Deps, id: Task["project_id"]) => (id === null ? Effect.succeed(null) : Effect.map(d.projects.get(id), Option.getOrNull))

/** Where a run's values are read from: its graph, its workflow's earlier runs on the task, and the project's prompts. */
export const valueSource = Effect.fnUntraced(function* (
  d: Deps,
  w: { readonly id: RunState["workflow_id"]; readonly name: string; readonly graph: RunState["graph"] },
  task: Task,
  project: Pick<Project, "start_prompt" | "review_prompt" | "merge_prompt"> | null,
  run: RunState | null,
) {
  const src: ValueSource = {
    graph: run?.graph ?? w.graph,
    workflow: w.name,
    task,
    key: task.key,
    run,
    earlier: yield* d.store.earlierRuns(w.id, task.id, run?.id ?? ""),
    projectPrompts: { start: projectStart(project), review: projectReview(project), merge: projectMerge(project) },
  }
  return src
})

/** A node of the run's graph by id. */
export const nodeOf = (run: RunState, id: string) => graphNode(run.graph, id)

/** Now, as rows store it. */
export const now: Effect.Effect<Timestamp> = nowTimestamp

/** The chain a run continues (0 for none). */
export const chainOf = (d: Deps, run: string) => Effect.map(Ref.get(d.chains), (m) => m.get(run) ?? 0)

/** Forgets a run's chain once it has ended. */
export const forgetChain = (d: Deps, run: string) =>
  Ref.update(d.chains, (m) => {
    if (!m.has(run)) return m
    const next = new Map(m)
    next.delete(run)
    return next
  })
