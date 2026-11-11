import { Context, Effect, Layer, Option } from "effect"
import { Conflict } from "@huntaway/contracts"
import type { Invalid, NotFound, ProjectId, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { ProjectNotFound } from "../projects/Projects.ts"
import { setupThread } from "../prompts/setupThread.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Runs } from "./Runs.ts"
import type { SendRefused } from "./Runs.ts"

export interface SetupThreadShape {
  /**
   * The project's setup thread (`setup_task_id`), whose agent helps the user make its folder a git repository with a
   * commit, so its tasks can have worktrees: a new one is started with `message` after its instructions; one the project
   * has already is returned as it is. `Conflict` when the folder is ready for worktrees already.
   */
  readonly start: (
    project: ProjectId,
    message: string,
  ) => Effect.Effect<Task, ProjectNotFound | Conflict | TaskNotFound | SendRefused | Invalid | NotFound | ProfileNotFound>
}

/** A project's setup thread (huntaway's api/thread.ts `start_setup_thread`): a task with no worktree, started at once. */
export class SetupThread extends Context.Service<SetupThread, SetupThreadShape>()("huntaway-server/runs/SetupThread") {
  static readonly layer = Layer.effect(
    SetupThread,
    Effect.gen(function* () {
      const projects = yield* ProjectRepo
      const repo = yield* TaskRepo
      const tasks = yield* Tasks
      const runs = yield* Runs
      const db = yield* Db
      const events = yield* Events
      const locks = yield* KeyedLock

      const start = Effect.fn("SetupThread.start")(function* (id: ProjectId, message: string) {
        // Under the project's lock, so two at once make one thread.
        const made = yield* locks.withLock(["project", id])(
          Effect.gen(function* () {
            const project = Option.getOrNull(yield* projects.get(id))
            if (project === null) return yield* new ProjectNotFound({ id })
            const existing = project.setup_task_id === null ? null : yield* repo.get(project.setup_task_id)
            if (existing !== null) return { task: existing, fresh: false }
            if (project.is_git && project.has_commits)
              return yield* new Conflict({ reason: "worktree_made", detail: `${project.repo_path} is ready for worktrees already` })
            const task = yield* tasks.create(
              { project_id: id, title: "Get the folder ready for worktrees", description: setupThread(project), use_worktree: false },
              Actor.user,
            )
            yield* db.tx(
              Effect.gen(function* () {
                yield* projects.update(id, { setup_task_id: task.id })
                const now = yield* projects.get(id)
                if (Option.isSome(now)) yield* events.emit({ type: "project", project: now.value })
              }),
            )
            return { task, fresh: true }
          }),
        )
        // Kept as the project's thread even if its agent can't start, to try again from.
        return made.fresh ? yield* runs.send(made.task.id, { text: message.trim(), source: "user" }) : made.task
      })

      return SetupThread.of({ start })
    }),
  )
}
