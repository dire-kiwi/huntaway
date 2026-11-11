import { Cause, Effect, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId, ProjectId, TaskId, type TaskWorkflowRuns, type Workflow } from "@huntaway/contracts"
import { HostClient } from "../session/HostClient.ts"
import { hostRuntime } from "../session/sessions.ts"
import { hostBoardAtom } from "./watch.ts"

// 6.6: a project's workflows (`workflows.list`) and a task's workflow runs (`workflows.runsOfTask`), read while something
// shows them, and again when the board says they changed (`workflows_changed`, `workflow_runs_changed`), as a task's
// turns are (turns.ts).

/** What a list reads: the latest read (kept while it's read again), and why the last failed. */
export interface ListView<A> {
  readonly data: A | null
  readonly failed: string | null
}

const split = (key: string): readonly [HostId, string] => {
  const [host = "", id = ""] = key.split("\u0000")
  return [HostId.make(host), id]
}

/** Why it couldn't be read, as a view says it. */
const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (Predicate.isTagged(error, "NotFound")) return "it isn't on its host"
  return "its host can't be reached"
}

const view = <A, E>(result: AsyncResult.AsyncResult<A, E>): ListView<A> => {
  if (AsyncResult.isSuccess(result)) return { data: result.value, failed: null }
  if (AsyncResult.isFailure(result)) return { data: Option.getOrNull(AsyncResult.value(result)), failed: failure(result.cause) }
  return { data: null, failed: null }
}

const workflowsVersion = Atom.family((key: string) =>
  Atom.make((get): string => {
    const [host, project] = split(key)
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(host))))
    return `${board?.boot ?? ""}:${board?.workflows.get(ProjectId.make(project)) ?? 0}`
  }),
)

const workflowsByKey = Atom.family((key: string) => {
  const [host, project] = split(key)
  return hostRuntime(host)
    .atom((get) => {
      get(workflowsVersion(key))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("workflows.list", { project_id: ProjectId.make(project) })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

const workflowsView = Atom.family((key: string) => Atom.make((get): ListView<ReadonlyArray<Workflow>> => view(get(workflowsByKey(key)))))

/** A project's workflows, read while something shows them, again as they change. */
export const workflowsAtom = (ref: { readonly host_id: string; readonly project_id: string }): Atom.Atom<ListView<ReadonlyArray<Workflow>>> =>
  workflowsView(`${ref.host_id}\u0000${ref.project_id}`)

const runsVersion = Atom.family((key: string) =>
  Atom.make((get): string => {
    const [host, task] = split(key)
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(host))))
    const id = TaskId.make(task)
    // A step's thread running or not changes what the task's tabs show, and so does the task's project's workflows.
    const t = board?.tasks.get(id)
    const project = t?.project_id ?? null
    return `${board?.boot ?? ""}:${board?.workflowRuns.get(id) ?? 0}:${project === null ? 0 : (board?.workflows.get(project) ?? 0)}`
  }),
)

const runsByKey = Atom.family((key: string) => {
  const [host, task] = split(key)
  return hostRuntime(host)
    .atom((get) => {
      get(runsVersion(key))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("workflows.runsOfTask", { task_id: TaskId.make(task) })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

const runsView = Atom.family((key: string) => Atom.make((get): ListView<TaskWorkflowRuns> => view(get(runsByKey(key)))))

/** A task's workflow runs and its project's workflows, read while something shows them, again as they change. */
export const workflowRunsAtom = (ref: { readonly host_id: string; readonly task_id: string }): Atom.Atom<ListView<TaskWorkflowRuns>> =>
  runsView(`${ref.host_id}\u0000${ref.task_id}`)
