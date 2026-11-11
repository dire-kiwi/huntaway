import { Context, Effect, Layer } from "effect"
import { Conflict } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import { Worktrees } from "../git/Worktrees.ts"
import type { Actor } from "../platform/Changes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { Runs } from "./Runs.ts"

export interface TaskDeletionShape {
  /**
   * Delete a task by hand, in order (docs/plan/06-server.md, Tasks): its agent and its reviewers' stop and their queues
   * go, its worktree is torn down forced (its branch deleted with `deleteBranch`) and the tasks stacked on it keep going
   * where it went (`Worktrees.forDeletion`), then `Tasks.delete` puts right what pointed at it and drops the row. What
   * follows the row's going (prompts expiring, its temp folder, M6's terminals) is the reactor's.
   */
  readonly delete: (id: TaskId, options: { readonly deleteBranch: boolean }, by: Actor) => Effect.Effect<void, TaskNotFound | Conflict>
}

/**
 * Where a task's deletion is put together: the one place the user's `tasks.delete` and an agent's approved `delete_task`
 * both reach. In the runs area, the lowest that sees both the runs to stop and the worktree to remove.
 */
export class TaskDeletion extends Context.Service<TaskDeletion, TaskDeletionShape>()("huntaway-server/runs/TaskDeletion") {
  static readonly layer = Layer.effect(
    TaskDeletion,
    Effect.gen(function* () {
      const runs = yield* Runs
      const repo = yield* TaskRepo
      const tasks = yield* Tasks
      const worktrees = yield* Worktrees

      const remove = Effect.fn("TaskDeletion.delete")(function* (id: TaskId, options: { readonly deleteBranch: boolean }, by: Actor) {
        const task = yield* repo.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        // The profile's assistant lasts (`Tasks.delete` refuses it too): its agent isn't stopped for nothing.
        if (task.kind === "task" && task.task_type === "assistant")
          return yield* new Conflict({ reason: "in_use", detail: "the profile's assistant can't be deleted" })
        // Its run is stopped at once and its queue dropped, and its reviewers', who work in its worktree.
        yield* runs.abort(id)
        for (const r of yield* repo.reviewThreads(id)) yield* runs.abort(r.id)
        yield* worktrees.forDeletion(task, options.deleteBranch)
        return yield* tasks.delete(id, options, by)
      })

      return TaskDeletion.of({ delete: remove })
    }),
  )
}
