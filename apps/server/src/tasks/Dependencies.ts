import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ProjectId, TaskId } from "@huntaway/contracts"
import { TaskId as TaskIdSchema } from "@huntaway/contracts"

/** A task is merged when it is done and its resolution (if any) is "done": what a dependency waits for. */
export const isMerged = (task: { readonly status: string; readonly resolution: string | null }): boolean =>
  task.status === "done" && (task.resolution === null || task.resolution === "done")

const WaitingRow = Schema.Struct({ id: TaskIdSchema, depends_on: Schema.String, limit_reset_at: Schema.NullOr(Schema.String) })
const DepRow = Schema.Struct({ id: TaskIdSchema, status: Schema.String, resolution: Schema.NullOr(Schema.String) })
const DependsOn = Schema.fromJsonString(Schema.Array(TaskIdSchema))

export interface DependenciesShape {
  /** Tasks queued for their dependencies (`waiting`, no usage-limit wait) in a project (every project for null) whose dependencies are all merged. */
  readonly ready: (projectId: ProjectId | null) => Effect.Effect<ReadonlyArray<TaskId>>
  /**
   * Start what `ready` finds (the old `start_unblocked`). Idempotent; called after a task moves, is deleted or changes
   * what it depends on, and at startup. Agents run from M2: until then a server cannot start them, so this finds
   * them and leaves them waiting, as the old server did when agents could not run.
   */
  readonly reconcile: (projectId: ProjectId | null) => Effect.Effect<void>
}

/** What a task waits on (docs/plan/inventory/07-server-root-api.md, 7.7; the old `db/tasks/deps.ts`). */
export class Dependencies extends Context.Service<Dependencies, DependenciesShape>()("huntaway-server/tasks/Dependencies") {
  static readonly layer = Layer.effect(
    Dependencies,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Not in an archived project; review threads and other kinds never wait.
      const waiting = SqlSchema.findAll({
        Request: Schema.NullOr(Schema.String),
        Result: WaitingRow,
        execute: (projectId) => sql`SELECT id, depends_on, limit_reset_at FROM tasks
          WHERE waiting = 1 AND kind = 'task' AND (${projectId} IS NULL OR project_id = ${projectId})
            AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
          ORDER BY position, created_at`,
      })
      const deps = SqlSchema.findAll({
        Request: Schema.Array(Schema.String),
        Result: DepRow,
        execute: (ids) => sql`SELECT id, status, resolution FROM tasks WHERE ${sql.in("id", ids)}`,
      })

      const ready = Effect.fn("Dependencies.ready")(function* (projectId: ProjectId | null) {
        const rows = yield* waiting(projectId).pipe(Effect.orDie)
        const out: Array<TaskId> = []
        for (const row of rows) {
          if (row.limit_reset_at !== null) continue
          const ids = yield* Schema.decodeEffect(DependsOn)(row.depends_on).pipe(Effect.orElseSucceed((): ReadonlyArray<TaskId> => []))
          // Deleted dependencies don't count.
          const found = ids.length === 0 ? [] : yield* deps(ids).pipe(Effect.orDie)
          if (found.every(isMerged)) out.push(row.id)
        }
        return out
      })

      const reconcile = Effect.fn("Dependencies.reconcile")(function* (projectId: ProjectId | null) {
        const found = yield* ready(projectId)
        if (found.length > 0) yield* Effect.logInfo(`${found.length} waiting task(s) could start, once agents can run on this server`)
      })

      return Dependencies.of({ ready, reconcile })
    }),
  )
}
