import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { RunId, TaskId } from "@huntaway/contracts"
import type { Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { encodeColumns } from "../platform/columns.ts"
import { Run } from "./Run.ts"
import type { RunKind, RunPhase, StopState } from "./Run.ts"

// The `runs` table (docs/plan/04-database.md; inventory 01, section 3). Statements only: no file, process or sleep, so
// any of these may run inside a transaction. The follower is the only writer of a run's progress columns.

/** The columns `Run` reads; `status` is its `phase`. The token counting columns (`usage_*`) are `Tokens`'. */
const COLUMNS = Object.keys(Run.fields)
  .map((name) => (name === "phase" ? "status AS phase" : name))
  .join(", ")

/** The progress columns a write may set; one left out or undefined is left as it is. */
export interface RunColumns {
  readonly stop?: StopState | undefined
  readonly stop_id?: string | null | undefined
  readonly between_turns?: boolean | undefined
  readonly saw_result?: boolean | undefined
  readonly result_error?: string | null | undefined
  readonly attention?: string | null | undefined
  readonly finished?: boolean | undefined
  readonly session_id?: string | null | undefined
  readonly config_dir?: string | null | undefined
  readonly effort?: string | null | undefined
  readonly board_tools?: boolean | undefined
  readonly agent_at?: string | null | undefined
  readonly write_no?: number | null | undefined
  readonly turn_start_tokens?: number | null | undefined
  readonly turn_tokens?: number | null | undefined
}

interface Found {
  readonly found: number
}

/** An `EXISTS(…) AS found` query's answer. */
const found = (rows: ReadonlyArray<Found>) => (rows[0]?.found ?? 0) !== 0

export interface NewRun {
  readonly id: RunId
  readonly task_id: TaskId
  readonly kind: RunKind
  readonly created_at: Timestamp
}

export interface RunRepoShape {
  /** A new run, `preparing`. */
  readonly insert: (run: NewRun) => Effect.Effect<Run>
  readonly get: (id: RunId) => Effect.Effect<Option.Option<Run>>
  /** Runs that have not exited, in the order they started. */
  readonly active: Effect.Effect<ReadonlyArray<Run>>
  /** Whether a run of the task has not exited. */
  readonly hasActive: (task: TaskId) => Effect.Effect<boolean>
  /** The task's latest run (of `kind`, if given). */
  readonly latest: (task: TaskId, kind?: RunKind) => Effect.Effect<Option.Option<Run>>
  /**
   * Whether a run of the same task has started since `run`. The latest run's start and end set the task's running
   * state and column; an earlier run that ends after it leaves them.
   */
  readonly laterThan: (run: Run) => Effect.Effect<boolean>
  /**
   * The folder the task's conversation `session` is kept in: the one its first run was given ("" for the agent's
   * default). None when that is not known (a session from before runs kept their folder).
   */
  readonly sessionConfigDir: (task: TaskId, session: string) => Effect.Effect<Option.Option<string>>
  /** The first run of the task's conversation `session` (the one that started it). */
  readonly sessionStartedBy: (task: TaskId, session: string) => Effect.Effect<Option.Option<RunId>>
  /** Codex: whether the task's session `session` has the board's tools as dynamic tools (its first run gave them). */
  readonly sessionBoardTools: (task: TaskId, session: string) => Effect.Effect<boolean>
  /**
   * Add what the run's agent has cost since it last said, from `total` (a Claude `result`'s `total_cost_usd` in
   * `session`), and return that. The total is the session's: the run is charged its increase over the session's last
   * total, the run's own or else its task's latest earlier run's in that session. A new session starts from nothing,
   * as does one whose total went down in a result that `counted` the model's use (it has `modelUsage`); a lower total
   * in a result that did not (Claude Code's own for a failed turn, with a total of 0) charges nothing.
   */
  readonly addCost: (run: RunId, session: string | null, total: number, counted: boolean) => Effect.Effect<number>
  /** Bytes of `out.jsonl` applied; returns `offset`. */
  readonly saveOffset: (run: RunId, offset: number) => Effect.Effect<number>
  readonly setPhase: (run: RunId, phase: RunPhase) => Effect.Effect<void>
  /** Set progress columns. */
  readonly update: (run: RunId, columns: RunColumns) => Effect.Effect<void>
  /**
   * The tasks whose conversation has been idle since `idleSince` but not since before `notBefore` (their latest run, a
   * prompt run, ended between the two), not running, not done, not waiting to merge or under review, in no archived
   * project: what idle-session compaction compacts.
   */
  readonly idleSessions: (idleSince: Timestamp, notBefore: Timestamp) => Effect.Effect<ReadonlyArray<TaskId>>
  /** The tasks marked running with no run that hasn't exited (their last run ended as the server stopped). */
  readonly idleRunning: Effect.Effect<ReadonlyArray<TaskId>>
  /** A live run between turns is in a turn again (`between_turns` 1 → 0). */
  readonly startTurn: (run: RunId) => Effect.Effect<void>
  /** Record the run as exited at `at`. False when it had already ended. */
  readonly end: (run: RunId, at: Timestamp) => Effect.Effect<boolean>
}

export class RunRepo extends Context.Service<RunRepo, RunRepoShape>()("huntaway-server/runs/RunRepo") {
  static readonly layer = Layer.effect(
    RunRepo,
    Effect.gen(function* () {
      const { sql, tx } = yield* Db
      const findOne = SqlSchema.findOneOption({
        Request: RunId,
        Result: Run,
        execute: (id) => sql.unsafe(`SELECT ${COLUMNS} FROM runs WHERE id = ?`, [id]),
      })
      const findActive = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Run,
        execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM runs WHERE status != 'exited' ORDER BY seq`),
      })
      const findLatest = SqlSchema.findOneOption({
        Request: Schema.Struct({ task: TaskId, kind: Schema.NullOr(Schema.String) }),
        Result: Run,
        execute: ({ task, kind }) =>
          sql.unsafe(`SELECT ${COLUMNS} FROM runs WHERE task_id = ? AND (? IS NULL OR kind = ?) ORDER BY seq DESC LIMIT 1`, [task, kind, kind]),
      })

      const get = (id: RunId) => findOne(id).pipe(Effect.orDie)

      const insert = (run: NewRun) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES (${run.id}, ${run.task_id}, ${run.kind}, 'preparing', ${run.created_at})`
          const row = yield* get(run.id)
          if (Option.isNone(row)) return yield* Effect.die(`run ${run.id} was not inserted`)
          return row.value
        }).pipe(Effect.orDie)

      const firstOfSession = (task: TaskId, session: string) =>
        sql<{ readonly config_dir: string | null; readonly board_tools: number }>`
          SELECT config_dir, board_tools FROM runs WHERE task_id = ${task} AND session_id = ${session} ORDER BY seq LIMIT 1`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
          Effect.orDie,
        )

      // Read and write in one transaction: the charge depends on what the session's last total was.
      const addCost = (run: RunId, session: string | null, total: number, counted: boolean) =>
        tx(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly session_cost: number }>`
              SELECT o.session_cost FROM runs r JOIN runs o ON o.task_id = r.task_id AND o.seq <= r.seq
              WHERE r.id = ${run} AND o.session_cost IS NOT NULL AND (o.session_id = ${session} OR (o.id = r.id AND ${session} IS NULL))
              ORDER BY o.seq DESC LIMIT 1`
            const before = rows[0]?.session_cost
            if (before !== undefined && before > total && !counted) return 0
            const cost = before !== undefined && before <= total ? total - before : total
            yield* sql`UPDATE runs SET cost_usd = cost_usd + ${cost}, session_id = COALESCE(${session}, session_id), session_cost = ${total} WHERE id = ${run}`
            return cost
          }),
        ).pipe(Effect.orDie)

      const update = (run: RunId, columns: RunColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns({ ...columns })
          if (Object.keys(row).length === 0) return
          yield* sql`UPDATE runs SET ${sql.update(row)} WHERE id = ${run}`
        }).pipe(Effect.orDie)

      return RunRepo.of({
        insert,
        get,
        active: findActive(undefined).pipe(Effect.orDie),
        hasActive: (task) =>
          sql<Found>`SELECT EXISTS(SELECT 1 FROM runs WHERE task_id = ${task} AND status != 'exited') AS found`.pipe(Effect.map(found), Effect.orDie),
        latest: (task, kind) => findLatest({ task, kind: kind ?? null }).pipe(Effect.orDie),
        laterThan: (run) =>
          sql<Found>`SELECT EXISTS(SELECT 1 FROM runs WHERE task_id = ${run.task_id} AND seq > ${run.seq}) AS found`.pipe(Effect.map(found), Effect.orDie),
        sessionConfigDir: (task, session) => firstOfSession(task, session).pipe(Effect.map(Option.flatMap((row) => Option.fromNullishOr(row.config_dir)))),
        sessionStartedBy: (task, session) =>
          sql<{ readonly id: RunId }>`SELECT id FROM runs WHERE task_id = ${task} AND session_id = ${session} ORDER BY seq LIMIT 1`.pipe(
            Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)),
            Effect.orDie,
          ),
        sessionBoardTools: (task, session) =>
          firstOfSession(task, session).pipe(Effect.map(Option.match({ onNone: () => false, onSome: (row) => row.board_tools === 1 }))),
        addCost,
        saveOffset: (run, offset) => sql`UPDATE runs SET out_offset = ${offset} WHERE id = ${run}`.pipe(Effect.as(offset), Effect.orDie),
        setPhase: (run, phase) => sql`UPDATE runs SET status = ${phase} WHERE id = ${run}`.pipe(Effect.asVoid, Effect.orDie),
        update,
        idleSessions: (idleSince, notBefore) =>
          sql<{ readonly id: TaskId }>`SELECT t.id FROM tasks t JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id = t.id ORDER BY seq DESC LIMIT 1)
            WHERE t.session_id IS NOT NULL AND t.running = 0 AND t.status != 'done' AND t.last_activity_at <= ${idleSince}
              AND NOT (t.merging = 1 AND t.status = 'ready_for_merge')
              AND (t.review IS NULL OR json_extract(t.review, '$.state') IS NOT 'running')
              AND (t.project_id IS NULL OR t.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
              AND r.kind = 'prompt' AND r.status = 'exited' AND r.ended_at <= ${idleSince} AND r.ended_at > ${notBefore}`.pipe(
            Effect.map((rows) => rows.map((r) => r.id)),
            Effect.orDie,
          ),
        idleRunning: sql<{ readonly id: TaskId }>`SELECT t.id FROM tasks t WHERE t.running = 1
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status != 'exited') ORDER BY t.created_at`.pipe(
          Effect.map((rows) => rows.map((r) => r.id)),
          Effect.orDie,
        ),
        startTurn: (run) =>
          sql`UPDATE runs SET between_turns = 0 WHERE id = ${run} AND between_turns = 1 AND status != 'exited'`.pipe(Effect.asVoid, Effect.orDie),
        end: (run, at) =>
          sql<{ readonly id: string }>`UPDATE runs SET status = 'exited', ended_at = ${at} WHERE id = ${run} AND status != 'exited' RETURNING id`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.orDie,
          ),
      })
    }),
  )
}
