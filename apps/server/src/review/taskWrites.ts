import { Effect } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import type { ChangesShape } from "../platform/Changes.ts"
import { Actor } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import type { DbShape } from "../platform/Db.ts"
import type { EventsShape } from "../platform/Events.ts"
import type { KeyedLockShape } from "../platform/KeyedLock.ts"
import { deriveColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import type { TaskRepoShape } from "../tasks/TaskRepo.ts"

// How reviews and summaries write a task (a reviewed task's `review`, `summaries` or column, a thread's session): under
// the task's lock, in one transaction that may read what decides the write first (a later run of the task, say), with
// the derived columns, the `task` event, and a `TaskChanged` for the reactor after the commit.

export interface Writes {
  readonly db: DbShape
  readonly locks: KeyedLockShape
  readonly tasks: TaskRepoShape
  readonly events: EventsShape
  readonly changes: ChangesShape
}

/**
 * Change task `id` with the columns `decide` returns for it as it is now, with what else it found (null: leave it).
 * The task after with that, or null when it was left (or is gone).
 */
export const changeTaskWith = <A, E>(
  w: Writes,
  id: TaskId,
  decide: (task: Task) => Effect.Effect<readonly [TaskColumns, A] | null, E>,
): Effect.Effect<{ readonly after: Task; readonly value: A } | null, E> =>
  w.locks
    .withLock(["task", id])(
      w.db.tx(
        Effect.gen(function* () {
          const before = yield* w.tasks.get(id)
          if (before === null) return null
          const decided = yield* decide(before)
          if (decided === null) return null
          const [columns, value] = decided
          const at = yield* nowTimestamp
          yield* w.tasks.write(id, deriveColumns(before, columns, at), at)
          const after = yield* w.tasks.get(id)
          if (after === null) return null
          yield* w.events.emit({ type: "task", task: after })
          return { before, after, value }
        }),
      ),
    )
    .pipe(
      Effect.tap((done) =>
        done === null ? Effect.void : w.changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: Actor.board }),
      ),
      Effect.map((done) => (done === null ? null : { after: done.after, value: done.value })),
    )

/** Change task `id` with the columns `decide` returns for it as it is now (null: leave it). The task after, or null. */
export const changeTask = <E>(w: Writes, id: TaskId, decide: (task: Task) => Effect.Effect<TaskColumns | null, E>): Effect.Effect<Task | null, E> =>
  changeTaskWith(w, id, (task) => Effect.map(decide(task), (columns) => (columns === null ? null : ([columns, undefined] as const)))).pipe(
    Effect.map((done) => done?.after ?? null),
  )

/** Write `columns` on task `id` as it is now. */
export const writeTask = (w: Writes, id: TaskId, columns: TaskColumns) => changeTask(w, id, () => Effect.succeed(columns))
