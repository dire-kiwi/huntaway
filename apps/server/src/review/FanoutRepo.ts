import { Context, Effect, Layer } from "effect"
import type { ProfileId, TaskId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"

// 6.11: what the fan-out compare view reads that isn't on the tasks (the old `db/tasks/read.ts` `fanout_tasks` and
// `run_time`).

export interface FanoutRepoShape {
  /** The tasks made from one prompt (`fanout_id`) in a profile, in the order they were made. */
  readonly siblings: (profile: ProfileId, fanout: string) => Effect.Effect<ReadonlyArray<TaskId>>
  /** How long a task's agent has run over all of its runs, in seconds (one still going counts up to `now`), and how many runs. */
  readonly runTime: (task: TaskId, now: Timestamp) => Effect.Effect<{ readonly secs: number; readonly runs: number }>
}

export class FanoutRepo extends Context.Service<FanoutRepo, FanoutRepoShape>()("huntaway-server/review/FanoutRepo") {
  static readonly layer = Layer.effect(
    FanoutRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      return FanoutRepo.of({
        siblings: (profile, fanout) =>
          sql<{ readonly id: TaskId }>`SELECT id FROM tasks WHERE profile_id = ${profile} AND fanout_id = ${fanout} AND kind = 'task'
            ORDER BY created_at, number`.pipe(
            Effect.map((rows) => rows.map((r) => r.id)),
            Effect.orDie,
          ),
        runTime: (task, now) =>
          sql<{ readonly secs: number; readonly runs: number }>`SELECT
              COALESCE(SUM(MAX(0, julianday(COALESCE(ended_at, ${now})) - julianday(created_at))), 0) * 86400 AS secs, COUNT(*) AS runs
            FROM runs WHERE task_id = ${task}`.pipe(
            Effect.map((rows) => ({ secs: rows[0]?.secs ?? 0, runs: rows[0]?.runs ?? 0 })),
            Effect.orDie,
          ),
      })
    }),
  )
}
