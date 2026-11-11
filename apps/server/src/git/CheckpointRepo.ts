import { Context, Effect, Layer, Schema } from "effect"
import type { SqlError } from "effect/sql"
import type { TaskId, Timestamp } from "@huntaway/contracts"
import { rowsOf, toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Checkpoint } from "./checkpoints/model.ts"

// The `checkpoints` rows (docs/plan/04-database.md; inventory 04, section 3.3), and what the plan rule reads beside them
// (a plan document written since a run started, tasks the run created). Statements only.

const COLUMNS = "n, kind, sha, tree, head, before_n, run_id, turn, write_no, status, session, agent_at, stats, stale, created_at"

const readRows = rowsOf(Checkpoint)
const Count = Schema.Struct({ n: Schema.Int })
const readCount = rowsOf(Count)

/** The first row's `n`, or 0. */
const count = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => Effect.map(readCount(statement), (rows) => rows[0]?.n ?? 0)

export interface CheckpointRepoShape {
  /** A task's checkpoints, oldest first. */
  readonly list: (task: TaskId) => Effect.Effect<ReadonlyArray<Checkpoint>>
  /** The latest checkpoint a rewind hasn't gone back past: where the next turn starts from. */
  readonly latest: (task: TaskId) => Effect.Effect<Checkpoint | null>
  /** The number the task's next checkpoint takes. */
  readonly nextN: (task: TaskId) => Effect.Effect<number>
  /** The number the task's next turn takes. */
  readonly nextTurn: (task: TaskId) => Effect.Effect<number>
  readonly insert: (task: TaskId, checkpoint: Checkpoint) => Effect.Effect<void>
  /** The numbers of the task's checkpoints past the newest `keep`. */
  readonly beyond: (task: TaskId, keep: number) => Effect.Effect<ReadonlyArray<number>>
  readonly remove: (task: TaskId, ns: ReadonlyArray<number>) => Effect.Effect<void>
  readonly removeAll: (task: TaskId) => Effect.Effect<void>
  /** Mark the checkpoints after `after` stale at `level` (or more), but `except`. */
  readonly markStale: (task: TaskId, after: number, level: 1 | 2, except: number) => Effect.Effect<void>
  /** Whether the task's plan document was written at `since` or later. */
  readonly planWrittenSince: (task: TaskId, since: Timestamp) => Effect.Effect<boolean>
  /** Whether the task created a task at `since` or later. */
  readonly createdTasksSince: (task: TaskId, since: Timestamp) => Effect.Effect<boolean>
}

export class CheckpointRepo extends Context.Service<CheckpointRepo, CheckpointRepoShape>()("huntaway-server/git/CheckpointRepo") {
  static readonly layer = Layer.effect(
    CheckpointRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      return CheckpointRepo.of({
        list: (task) => readRows(sql.unsafe(`SELECT ${COLUMNS} FROM checkpoints WHERE task_id = ? ORDER BY n`, [task])),
        latest: (task) =>
          Effect.map(
            readRows(sql.unsafe(`SELECT ${COLUMNS} FROM checkpoints WHERE task_id = ? AND stale = 0 ORDER BY n DESC LIMIT 1`, [task])),
            (rows) => rows[0] ?? null,
          ),
        nextN: (task) => count(sql`SELECT COALESCE(MAX(n), -1) + 1 AS n FROM checkpoints WHERE task_id = ${task}`),
        nextTurn: (task) => count(sql`SELECT COALESCE(MAX(turn), 0) + 1 AS n FROM checkpoints WHERE task_id = ${task}`),
        insert: (task, c) =>
          Effect.gen(function* () {
            const stats = c.stats === null ? null : yield* toJson(c.stats)
            yield* sql`INSERT INTO checkpoints (task_id, n, kind, sha, tree, head, before_n, run_id, turn, write_no, status, session, agent_at, stats, stale, created_at)
              VALUES (${task}, ${c.n}, ${c.kind}, ${c.sha}, ${c.tree}, ${c.head}, ${c.before_n}, ${c.run_id}, ${c.turn}, ${c.write_no}, ${c.status}, ${c.session},
                ${c.agent_at}, ${stats}, ${c.stale}, ${c.created_at})`
          }).pipe(Effect.orDie),
        beyond: (task, keep) =>
          Effect.map(readCount(sql`SELECT n FROM checkpoints WHERE task_id = ${task} ORDER BY n DESC LIMIT -1 OFFSET ${keep}`), (rows) => rows.map((r) => r.n)),
        remove: (task, ns) =>
          Effect.forEach(ns, (n) => sql`DELETE FROM checkpoints WHERE task_id = ${task} AND n = ${n}`, { concurrency: 1, discard: true }).pipe(Effect.orDie),
        removeAll: (task) => sql`DELETE FROM checkpoints WHERE task_id = ${task}`.pipe(Effect.asVoid, Effect.orDie),
        markStale: (task, after, level, except) =>
          sql`UPDATE checkpoints SET stale = MAX(stale, ${level}) WHERE task_id = ${task} AND n > ${after} AND n <> ${except}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        planWrittenSince: (task, since) =>
          Effect.map(count(sql`SELECT COUNT(*) AS n FROM documents WHERE task_id = ${task} AND label = 'plan' AND updated_at >= ${since}`), (n) => n > 0),
        createdTasksSince: (task, since) =>
          Effect.map(count(sql`SELECT COUNT(*) AS n FROM tasks WHERE created_by = ${task} AND created_at >= ${since}`), (n) => n > 0),
      })
    }),
  )
}
