import { Context, Effect, FiberSet, FileSystem, Layer, Option, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Project, Status, Task, TaskId } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { expandHome, truncate } from "./paths.ts"
import { runScript, scriptEnv } from "./worktree/scripts.ts"

// A project's status scripts (huntaway's integrations/status_script.ts; inventory 04, section 2.5): its status script
// runs with bash whenever one of its tasks moves to another column, and each column's script whenever a task moves into
// that column, whatever moved it (the user, its agent, a review, a merge), e.g. to notify someone, update another
// tracker or clean up a done task's build. They run in the background in the task's worktree (the repository when the
// task has none), and a task's scripts run one at a time in the order its status changed, the status script before the
// column's. Their output goes in the task's thread.

/** How long a status script may run before it's stopped. */
const LIMIT = "5 minutes"

/** A status change whose scripts haven't run yet: the task right after it, and the status it left. */
interface Change {
  readonly task: Task
  readonly old: Status
}

/** A status's column name on the board. */
const LABELS: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  needs_attention: "Needs attention",
  in_review: "In review",
  ready_for_merge: "Ready for merge",
  done: "Done",
}
const label = (status: string) => LABELS[status] ?? status

/** The scripts to run when a task moves to `status`, each with its name for the thread: the project's status script, then the column's. */
export const statusScripts = (project: Pick<Project, "status_script" | "status_scripts">, status: Status): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [["Status script", project.status_script]]
  const column = project.status_scripts[status]
  if (column !== undefined) out.push([`${label(status)} script`, column])
  return out.filter(([, s]) => s.trim() !== "")
}

export interface StatusScriptsShape {
  /**
   * Task `task` (as it is right after the change) moved from `old`: queue its project's scripts for it. Returns at once;
   * the scripts run in the background, a task's in the order its changes were queued. Only for a `kind=task`.
   */
  readonly changed: (task: Task, old: Status) => Effect.Effect<void>
  /** Waits until every queued script has run: what tests wait on. */
  readonly idle: Effect.Effect<void>
}

export class StatusScripts extends Context.Service<StatusScripts, StatusScriptsShape>()("huntaway-server/git/StatusScripts") {
  static readonly layer = Layer.effect(
    StatusScripts,
    Effect.gen(function* () {
      const projects = yield* ProjectRepo
      const threads = yield* Threads
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scripts = { spawner, agentEnv: config.agentEnv }
      // Each task's queue of changes whose scripts haven't run yet, while it has any (its runner is going).
      const queues = yield* Ref.make<ReadonlyMap<TaskId, ReadonlyArray<Change>>>(new Map())
      const runners = yield* FiberSet.make()

      const isDir = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((i) => i.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )

      const run = Effect.fnUntraced(function* ({ task, old }: Change) {
        // The scripts as they are now, in case they changed since.
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        if (project === null) return
        const list = statusScripts(project, task.status)
        if (list.length === 0) return
        const wt = task.worktree_path !== null && task.worktree_state === "ready" && (yield* isDir(task.worktree_path)) ? task.worktree_path : null
        const dir = wt ?? expandHome(project.repo_path, config.home)
        // The setup script's variables (with an empty IA_WORKTREE_PATH when the task has no worktree), and the change.
        const env: ReadonlyArray<readonly [string, string]> = [
          ...scriptEnv(project, task, wt ?? "", task.branch ?? ""),
          ["IA_TASK_KEY", `${project.key}-${task.number}`],
          ["IA_TASK_TITLE", task.title],
          ["IA_OLD_STATUS", old],
          ["IA_NEW_STATUS", task.status],
          ["IA_RESOLUTION", task.resolution ?? ""],
          ["IA_PR_URL", task.pr_url ?? ""],
        ]
        const change = `${label(old)} → ${label(task.status)}`
        for (const [name, script] of list) {
          const ran = yield* Effect.result(runScript(scripts, script, dir, env, LIMIT))
          if (ran._tag === "Success") {
            const log = ran.success.trim()
            yield* threads.notice(task.id, "info", `${name} ran (${change})`, log === "" ? undefined : truncate(log, 20000)).pipe(Effect.ignore)
          } else yield* threads.notice(task.id, "warning", `${name} failed (${change})`, ran.failure.reason).pipe(Effect.ignore)
        }
      })

      /** Run a task's queued scripts until there are none left. */
      const drain = (id: TaskId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const next = yield* Ref.modify(queues, (all): readonly [Change | null, ReadonlyMap<TaskId, ReadonlyArray<Change>>] => {
            const [head, ...rest] = all.get(id) ?? []
            const map = new Map(all)
            if (head === undefined) map.delete(id)
            else map.set(id, rest)
            return [head ?? null, map]
          })
          if (next === null) return
          yield* run(next).pipe(Effect.catchCause((cause) => Effect.logError(`status script of ${id}`, cause)))
          yield* drain(id)
        })

      const changed = Effect.fn("StatusScripts.changed")(function* (task: Task, old: Status) {
        if (task.kind !== "task" || task.status === old || task.project_id === null) return
        const project = Option.getOrNull(yield* projects.get(task.project_id))
        if (project === null || statusScripts(project, task.status).length === 0) return
        const start = yield* Ref.modify(queues, (all): readonly [boolean, ReadonlyMap<TaskId, ReadonlyArray<Change>>] => {
          const queued = all.get(task.id)
          const map = new Map(all)
          map.set(task.id, [...(queued ?? []), { task, old }])
          return [queued === undefined, map]
        })
        if (start) yield* FiberSet.run(runners, drain(task.id))
      })

      return StatusScripts.of({ changed, idle: FiberSet.awaitEmpty(runners) })
    }),
  )
}
