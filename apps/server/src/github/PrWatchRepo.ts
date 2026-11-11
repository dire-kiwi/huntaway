import { Context, Effect, Layer, Schema } from "effect"
import { TaskId, WatchPullRequests } from "@huntaway/contracts"
import type { Timestamp } from "@huntaway/contracts"
import { NullableJsonColumn, rowsOf, toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { WatchRow } from "./prWatch/seen.ts"

// The pull requests' rows (docs/plan/inventory/03-mcp.md section 3, 04-git-review.md section 3.3): what each task's
// agent has been told about each of its pull requests (`pr_watches`), the state of a task's pull request the merged
// watcher last acted on (`pr_states`), and the tasks the two watchers read. Statements only.

const StateRows = Schema.Struct({ state: NullableJsonColumn(WatchRow) })
const readState = rowsOf(StateRows)
const PrStateRows = Schema.Struct({ state: Schema.String })
const readPrState = rowsOf(PrStateRows)
const Watched = Schema.Struct({ id: TaskId, mode: WatchPullRequests })
const readWatched = rowsOf(Watched)
const Ids = Schema.Struct({ id: TaskId })
const readIds = rowsOf(Ids)

export interface PrWatchRepoShape {
  /** What task `task`'s agent has been told about pull request `pr` (`targetKey`), if anything (and it can be read). */
  readonly get: (task: TaskId, pr: string) => Effect.Effect<WatchRow | null>
  readonly put: (task: TaskId, pr: string, row: WatchRow, now: Timestamp) => Effect.Effect<void>
  /** The state of task `task`'s pull request at `url` the merged watcher last acted on. */
  readonly prState: (task: TaskId, url: string) => Effect.Effect<string | null>
  readonly setPrState: (task: TaskId, url: string, state: string, now: Timestamp) => Effect.Effect<void>
  /**
   * The tasks in In review with a pull request, in projects that watch theirs (not archived), with the project's
   * `watch_pull_requests`.
   */
  readonly inReview: Effect.Effect<ReadonlyArray<{ readonly id: TaskId; readonly mode: WatchPullRequests }>>
  /**
   * The tasks in In review or Needs attention with a pull request, not merging or running, in projects done when
   * their pull request is merged: the merged watcher's.
   */
  readonly withOpenPrs: Effect.Effect<ReadonlyArray<TaskId>>
}

export class PrWatchRepo extends Context.Service<PrWatchRepo, PrWatchRepoShape>()("huntaway-server/github/PrWatchRepo") {
  static readonly layer = Layer.effect(
    PrWatchRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      return PrWatchRepo.of({
        get: (task, pr) => Effect.map(readState(sql`SELECT state FROM pr_watches WHERE task_id = ${task} AND pr = ${pr}`), (rows) => rows[0]?.state ?? null),
        put: (task, pr, row, now) =>
          Effect.gen(function* () {
            const state = yield* toJson(row)
            yield* sql`INSERT INTO pr_watches (task_id, pr, state, updated_at) VALUES (${task}, ${pr}, ${state}, ${now})
              ON CONFLICT(task_id, pr) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
          }).pipe(Effect.orDie),
        prState: (task, url) =>
          Effect.map(readPrState(sql`SELECT state FROM pr_states WHERE task_id = ${task} AND pr_url = ${url}`), (rows) => rows[0]?.state ?? null),
        setPrState: (task, url, state, now) =>
          sql`INSERT INTO pr_states (task_id, pr_url, state, updated_at) VALUES (${task}, ${url}, ${state}, ${now})
            ON CONFLICT(task_id, pr_url) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`.pipe(Effect.asVoid, Effect.orDie),
        inReview: readWatched(sql`SELECT t.id AS id, p.watch_pull_requests AS mode FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.kind = 'task' AND t.status = 'in_review' AND COALESCE(t.pr_url, '') != ''
            AND p.watch_pull_requests != 'off' AND p.archived_at IS NULL
          ORDER BY t.project_id, t.number`),
        withOpenPrs: Effect.map(
          readIds(sql`SELECT t.id AS id FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE t.kind = 'task' AND t.status IN ('in_review', 'needs_attention') AND t.pr_url IS NOT NULL AND t.merging = 0 AND t.running = 0
              AND t.task_type IS NULL AND p.done_when_merged = 1
            ORDER BY t.project_id, t.number`),
          (rows) => rows.map((r) => r.id),
        ),
      })
    }),
  )
}
