import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { rowsOf } from "../platform/columns.ts"

// A stack's hidden column (huntaway's Task.stack_input): what its title and description were last written from, kept on
// its bottom task and not on the wire, so an unchanged stack isn't written again. The other stack columns are the
// task's own (`Tasks.change`). Statements only.

const Input = Schema.Struct({ id: TaskId, stack_input: Schema.NullOr(Schema.String) })
const inputRows = rowsOf(Input)
const Id = Schema.Struct({ id: TaskId })
const idRows = rowsOf(Id)

export interface StackTitleRepoShape {
  /** What each of `ids` was written from, for those that have one. */
  readonly inputs: (ids: ReadonlyArray<TaskId>) => Effect.Effect<ReadonlyMap<TaskId, string>>
  readonly setInput: (id: TaskId, input: string | null) => Effect.Effect<void>
  /** Open tasks that land after another (`start_from` a task, merging into none), oldest first: the stacks a start looks at. */
  readonly openLevels: Effect.Effect<ReadonlyArray<TaskId>>
}

export class StackTitleRepo extends Context.Service<StackTitleRepo, StackTitleRepoShape>()("huntaway-server/agents/StackTitleRepo") {
  static readonly layer = Layer.effect(
    StackTitleRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return StackTitleRepo.of({
        inputs: (ids) =>
          ids.length === 0
            ? Effect.succeed(new Map())
            : Effect.map(
                inputRows(sql`SELECT id, stack_input FROM tasks WHERE ${sql.in("id", ids)} AND stack_input IS NOT NULL`),
                (rows) => new Map(rows.flatMap((r) => (r.stack_input === null ? [] : [[r.id, r.stack_input] as const]))),
              ),
        setInput: (id, input) => sql`UPDATE tasks SET stack_input = ${input} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        openLevels: Effect.map(
          idRows(sql`SELECT id FROM tasks WHERE kind = 'task' AND status != 'done' AND merges_into IS NULL AND start_from IS NOT NULL
            AND json_valid(start_from) AND json_extract(start_from, '$.type') = 'task' ORDER BY created_at`),
          (rows) => rows.map((r) => r.id),
        ),
      })
    }),
  )
}
