import { Context, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, TaskId } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { stackOf } from "./lanes.ts"
import type { Rows } from "./lanes.ts"
import { TaskRepo } from "./TaskRepo.ts"
import { TaskNotFound } from "./Tasks.ts"

// A stack's own thread (HE-105): one lasting thread per stack, which the user messages to restack it (rebase its levels
// onto each other, force-push them, fix their pull requests' bases) rather than chasing each level's agent, and which its
// levels' agents hand stack work to. It's a task of the stack's project (`task_type` `stack`, keyed and numbered as the
// project's), under the stack's bottom task (`parent_id`), off the board's columns; the Stack card opens it.

/** A stack thread's title, after its stack's: its own title, else its bottom task's. */
export const stackThreadTitle = (bottom: Pick<Task, "title" | "stack_title">): string => `Stack: ${bottom.stack_title?.trim() || bottom.title}`

/** Whether `t` is a stack's own thread. */
export const isStackThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "stack"

/**
 * The thread of the stack whose levels are `levels`, among `rows`: the one under its bottom, else one under another of
 * its levels (left there when the stack grew below it, or its bottom changed). Null when it has none yet.
 */
export const stackThreadOf = (rows: Rows, levels: ReadonlyArray<Pick<Task, "id">>): Task | null => {
  const at = (t: Task) => levels.findIndex((l) => l.id === t.parent_id)
  return rows.filter((t) => isStackThread(t) && at(t) >= 0).toSorted((a, b) => at(a) - at(b))[0] ?? null
}

export interface StackThreadsShape {
  /**
   * The thread of the stack task `id` is in (any level), made the first time it's asked for: in the stack's project,
   * under its bottom, titled after it. Emits `task` when it's made. `Invalid` for a task in no stack, or a stack in no
   * project (it has no repository to restack).
   */
  readonly thread: (id: TaskId) => Effect.Effect<Task, TaskNotFound | Invalid>
  /** The thread of the stack `task` is in, if it has one; never made here. */
  readonly find: (task: Task) => Effect.Effect<Task | null>
}

export class StackThreads extends Context.Service<StackThreads, StackThreadsShape>()("huntaway-server/tasks/StackThreads") {
  static readonly layer = Layer.effect(
    StackThreads,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const db = yield* Db
      const events = yield* Events
      const random = yield* SecureRandom.SecureRandom

      /** The stack `t` is in, from its project's tasks of its profile, with those tasks. */
      const stackIn = Effect.fnUntraced(function* (t: Task) {
        if (t.project_id === null || t.kind !== "task") return null
        const rows = (yield* repo.projectTasks(t.project_id)).filter((x) => x.kind === "task" && x.profile_id === t.profile_id)
        const stack = stackOf(rows, t)
        return stack === null ? null : { rows, stack }
      })

      const find = Effect.fn("StackThreads.find")(function* (task: Task) {
        const found = yield* stackIn(task)
        return found === null ? null : stackThreadOf(found.rows, found.stack.levels)
      })

      const thread = Effect.fn("StackThreads.thread")(function* (id: TaskId) {
        const asked = yield* repo.get(id)
        if (asked === null) return yield* new TaskNotFound({ id })
        if (isStackThread(asked)) return asked
        const made = yield* db.tx(
          Effect.gen(function* () {
            // Looked for in the transaction that makes it, so two first opens make one.
            const found = yield* stackIn(asked)
            if (found === null) return yield* new Invalid({ field: "id", reason: "the task isn't in a stack" })
            const had = stackThreadOf(found.rows, found.stack.levels)
            if (had !== null) return { task: had, made: false }
            const { bottom } = found.stack
            const project = bottom.project_id === null ? null : yield* repo.project(bottom.project_id)
            if (project === null) return yield* new Invalid({ field: "id", reason: "the stack isn't in a project" })
            const configs = yield* repo.configs(bottom.profile_id, project)
            const threadId = TaskId.make(yield* random.uuidV4())
            yield* repo.insert(
              threadId,
              {
                family: "project",
                profile_id: bottom.profile_id,
                project_id: bottom.project_id,
                generateTitle: false,
                columns: {
                  title: stackThreadTitle(bottom),
                  title_pinned: true,
                  description: "",
                  status: "todo",
                  task_type: "stack",
                  parent_id: bottom.id,
                  use_worktree: false,
                  claude_config_id: configs[0] ?? null,
                },
              },
              yield* nowTimestamp,
            )
            const task = yield* repo.get(threadId)
            if (task === null) return yield* Effect.die(new Error("the stack thread's row is gone"))
            return { task, made: true }
          }),
        )
        if (made.made) yield* events.emit({ type: "task", task: made.task })
        return made.task
      })

      return StackThreads.of({ thread, find })
    }),
  )
}
