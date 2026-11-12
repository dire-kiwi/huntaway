import { Context, Effect, Layer } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { untrack } from "./trackedList.ts"

// The assistant's tracked work as the user changes it (huntaway's agent/assistant/tracked.ts `remove_handler`, the old
// `POST /tasks/{id}/tracked/remove`): the assistant's details take items off its list. The assistant's own changes are
// its board tools (`mcp/tools/tracking.ts`); the list's rules are `trackedList.ts`.

export interface TrackedShape {
  /** Takes the items with these ids off an assistant's list (in one read and write); the assistant as it is now. */
  readonly remove: (task: TaskId, ids: ReadonlyArray<string>) => Effect.Effect<Task, TaskNotFound | Invalid>
}

export class Tracked extends Context.Service<Tracked, TrackedShape>()("huntaway-server/assistant/Tracked") {
  static readonly layer = Layer.effect(
    Tracked,
    Effect.gen(function* () {
      const tasks = yield* Tasks
      const repo = yield* TaskRepo

      const remove = Effect.fn("Tracked.remove")(function* (id: TaskId, ids: ReadonlyArray<string>) {
        const t = yield* repo.get(id)
        if (t === null) return yield* new TaskNotFound({ id })
        if (t.kind !== "task" || t.task_type !== "assistant") return yield* new Invalid({ field: "id", reason: "only an assistant has tracked work" })
        return yield* tasks.change(
          id,
          (now) => {
            const { list, removed } = untrack(now.tracked, ids)
            return removed === 0 ? null : { tracked: list }
          },
          Actor.user,
        )
      })

      return Tracked.of({ remove })
    }),
  )
}
