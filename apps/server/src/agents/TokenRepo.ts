import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { AgentConfigId } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import type { Counted } from "./tokens/count.ts"
import { sorted, splitColumns } from "./tokens/counts.ts"

// The token counting's rows (huntaway's agent/tokens.ts): `token_usage`, and the `usage_*` columns of `runs` that hold
// the running totals the next run is counted against (`runs/RunRepo` leaves them to this). Statements only.

/** A run that has ended and has not been counted. */
export const PendingRun = Schema.Struct({ id: RunId, task_id: TaskId, seq: Schema.Int, cost_usd: Schema.Finite, created_at: Timestamp })
export type PendingRun = typeof PendingRun.Type

/** What an earlier counted run saved: the session it was counted in, its snapshot and tail as JSON text. */
const Saved = Schema.Struct({ usage_session: Schema.NullOr(Schema.String), usage_snapshot: Schema.String, usage_tail: Schema.NullOr(Schema.String) })
export type Saved = typeof Saved.Type

const Agent = Schema.Struct({ agent: Schema.String })
const Model = Schema.Struct({ model: Schema.String })

/**
 * What the latest of `saved` (latest first) has for session (or Codex thread) `key`: the run counted in that session,
 * or one counted with no session whose snapshot names it (a Codex run's threads).
 */
export const savedFor = (saved: ReadonlyArray<Saved>, key: string): Saved | null =>
  saved.find((s) => s.usage_session === key || (s.usage_session === null && s.usage_snapshot.includes(`"${key}"`))) ?? null

export interface TokenRepoShape {
  /** The runs that have exited and have not been counted (only `task`'s, if given), oldest first for each task. */
  readonly pending: (task: TaskId | null) => Effect.Effect<ReadonlyArray<PendingRun>>
  /** What the task's counted runs before `seq` saved, latest first (`savedFor` picks one for a session or thread). */
  readonly savedBefore: (task: TaskId, seq: number) => Effect.Effect<ReadonlyArray<Saved>>
  /** Marks a run counted with nothing saved: one that could not be counted, so it isn't tried again and again. */
  readonly markCounted: (run: RunId, at: Timestamp) => Effect.Effect<void>
  /**
   * Keeps what a run used and its totals, unless a count that started before this one has counted it already: whether
   * it did. Run it in a transaction (`Db.tx`), which the check and the writes need.
   */
  readonly save: (run: RunId, counted: Counted, at: Timestamp) => Effect.Effect<boolean>
  /** The model a run's turns were recorded on (`context_stats`), if any. */
  readonly runModel: (run: RunId) => Effect.Effect<string | null>
  /** The agent of a config (`claude`, `codex`), if it is there. */
  readonly configAgent: (config: AgentConfigId) => Effect.Effect<string | null>
  /** 6.9: what telemetry's `run_end` says of a run. */
  readonly runFacts: (run: RunId) => Effect.Effect<RunFacts | null>
}

/** 6.9: a run's kind, times and how it ended, for telemetry's `run_end`. */
export const RunFacts = Schema.Struct({
  kind: Schema.String,
  created_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  result_error: Schema.NullOr(Schema.String),
  saw_result: Schema.Int,
  attention: Schema.NullOr(Schema.String),
  stop: Schema.String,
  finished: Schema.Int,
})
export type RunFacts = typeof RunFacts.Type

export class TokenRepo extends Context.Service<TokenRepo, TokenRepoShape>()("huntaway-server/agents/TokenRepo") {
  static readonly layer = Layer.effect(
    TokenRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const pendingAll = SqlSchema.findAll({
        Request: Schema.NullOr(TaskId),
        Result: PendingRun,
        execute: (task) =>
          sql`SELECT id, task_id, seq, cost_usd, created_at FROM runs WHERE status = 'exited' AND usage_at IS NULL
                AND (${task} IS NULL OR task_id = ${task}) ORDER BY task_id, seq`,
      })
      const pending = (task: TaskId | null) => pendingAll(task).pipe(Effect.orDie)

      const savedBefore = (task: TaskId, seq: number) =>
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: Saved,
          execute: () =>
            sql`SELECT usage_session, usage_snapshot, usage_tail FROM runs WHERE task_id = ${task} AND seq < ${seq} AND usage_snapshot IS NOT NULL
                ORDER BY seq DESC`,
        })(undefined).pipe(Effect.orDie)

      const markCounted = (run: RunId, at: Timestamp) => sql`UPDATE runs SET usage_at = ${at} WHERE id = ${run}`.pipe(Effect.asVoid, Effect.orDie)

      const save = Effect.fnUntraced(function* (run: RunId, counted: Counted, at: Timestamp) {
        // Counted already, by a count that started before this one finished: leave it.
        const open = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM runs WHERE id = ${run} AND usage_at IS NULL`
        if ((open[0]?.n ?? 0) === 0) return false
        for (const [model, n] of Object.entries(counted.models)) {
          const [oneHour, fiveMinutes] = splitColumns(counted.runtime, n)
          yield* sql`INSERT OR REPLACE INTO token_usage (run_id, model, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, cost_usd, estimated, cache_write_1h_tokens, cache_write_5m_tokens)
            VALUES (${run}, ${model}, ${counted.runtime}, ${n.input}, ${n.output}, ${n.cache_read}, ${n.cache_write}, ${n.reasoning},
              ${counted.runtime === "claude" ? n.cost : null}, ${counted.estimated ? 1 : 0}, ${oneHour}, ${fiveMinutes})`
        }
        const snapshot = Object.keys(counted.snapshot).length === 0 ? null : yield* toJson(sorted(counted.snapshot))
        const tail = Object.keys(counted.tail).length === 0 ? null : yield* toJson(sorted(counted.tail))
        yield* sql`UPDATE runs SET usage_at = ${at}, usage_session = ${counted.session}, usage_snapshot = ${snapshot}, usage_tail = ${tail} WHERE id = ${run}`
        return true
      }, Effect.orDie)

      const runModel = (run: RunId) =>
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: Model,
          execute: () => sql`SELECT model FROM context_stats WHERE run_id = ${run} AND model IS NOT NULL ORDER BY id DESC LIMIT 1`,
        })(undefined).pipe(
          Effect.map((rows) => rows[0]?.model ?? null),
          Effect.orDie,
        )

      const configAgent = (config: AgentConfigId) =>
        SqlSchema.findAll({ Request: Schema.Void, Result: Agent, execute: () => sql`SELECT agent FROM agent_configs WHERE id = ${config}` })(undefined).pipe(
          Effect.map((rows) => rows[0]?.agent ?? null),
          Effect.orDie,
        )

      const runFacts = (run: RunId) =>
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: RunFacts,
          execute: () => sql`SELECT kind, created_at, ended_at, result_error, saw_result, attention, stop, finished FROM runs WHERE id = ${run}`,
        })(undefined).pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.orDie,
        )

      return TokenRepo.of({ pending, savedBefore, markCounted, save, runModel, configAgent, runFacts })
    }),
  )
}
