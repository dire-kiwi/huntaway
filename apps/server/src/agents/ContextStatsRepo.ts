import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { RunId, TaskId, Timestamp } from "@huntaway/contracts"

// The context meter's rows (huntaway's agent/context.ts): `context_stats` (a row for the end of each turn and one for
// each compaction, which outlive the session), the turn's sizes on its run (`runs.turn_start_tokens`, `turn_tokens`)
// and the latest breakdown on its task (`tasks.context_detail`, which the wire `Task` does not carry). Statements only.

/** A turn's end: the context it started from and leaves, and what it cost. */
export interface TurnStat {
  readonly task_id: TaskId
  readonly run_id: RunId
  readonly at: Timestamp
  readonly tokens: number
  readonly start_tokens: number | null
  readonly max_tokens: number | null
  readonly model: string | null
  readonly cost_usd: number | null
}

/** A compaction: how big the context was and what it left, where it came from. */
export interface CompactStat {
  readonly task_id: TaskId
  readonly run_id: RunId
  readonly at: Timestamp
  readonly tokens: number | null
  readonly post_tokens: number | null
  readonly max_tokens: number | null
  readonly model: string | null
  readonly source: "auto" | "idle" | "user"
  readonly duration_ms: number | null
}

const Turn = Schema.Struct({ turn_start_tokens: Schema.NullOr(Schema.Int), turn_tokens: Schema.NullOr(Schema.Int) })
const Detail = Schema.Struct({ context_detail: Schema.NullOr(Schema.String) })

export interface ContextStatsRepoShape {
  /** A request in the run's current turn: the first says what the turn started from, the latest what it's got to. */
  readonly turnUsage: (run: RunId, tokens: number) => Effect.Effect<void>
  /** A turn the agent compacted in leaves the summary, unless the model goes on after it. */
  readonly compactedTurn: (run: RunId, tokens: number) => Effect.Effect<void>
  /** The run's current turn's sizes, cleared for the next turn; null for a run that isn't there. Run it in a transaction. */
  readonly takeTurn: (run: RunId) => Effect.Effect<{ readonly start: number | null; readonly end: number | null } | null>
  readonly insertTurn: (stat: TurnStat) => Effect.Effect<void>
  readonly insertCompaction: (stat: CompactStat) => Effect.Effect<void>
  /** The task's latest breakdown, as JSON text. */
  readonly detail: (task: TaskId) => Effect.Effect<string | null>
  readonly setDetail: (task: TaskId, detail: string | null) => Effect.Effect<void>
}

export class ContextStatsRepo extends Context.Service<ContextStatsRepo, ContextStatsRepoShape>()("huntaway-server/agents/ContextStatsRepo") {
  static readonly layer = Layer.effect(
    ContextStatsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const turnUsage = (run: RunId, tokens: number) =>
        sql`UPDATE runs SET turn_start_tokens = COALESCE(turn_start_tokens, ${tokens}), turn_tokens = ${tokens} WHERE id = ${run}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        )

      const compactedTurn = (run: RunId, tokens: number) =>
        sql`UPDATE runs SET turn_tokens = ${tokens} WHERE id = ${run} AND turn_tokens IS NOT NULL`.pipe(Effect.asVoid, Effect.orDie)

      const turnOf = SqlSchema.findAll({
        Request: Schema.String,
        Result: Turn,
        execute: (run) => sql`SELECT turn_start_tokens, turn_tokens FROM runs WHERE id = ${run}`,
      })
      const takeTurn = Effect.fnUntraced(function* (run: RunId) {
        const [turn] = yield* turnOf(run)
        if (turn === undefined) return null
        yield* sql`UPDATE runs SET turn_start_tokens = NULL, turn_tokens = NULL WHERE id = ${run}`
        return { start: turn.turn_start_tokens, end: turn.turn_tokens }
      }, Effect.orDie)

      const insertTurn = (s: TurnStat) =>
        sql`INSERT INTO context_stats (task_id, run_id, kind, at, tokens, start_tokens, max_tokens, model, cost_usd)
            VALUES (${s.task_id}, ${s.run_id}, 'turn', ${s.at}, ${s.tokens}, ${s.start_tokens}, ${s.max_tokens}, ${s.model}, ${s.cost_usd})`.pipe(
          Effect.asVoid,
          Effect.orDie,
        )

      const insertCompaction = (s: CompactStat) =>
        sql`INSERT INTO context_stats (task_id, run_id, kind, at, tokens, post_tokens, max_tokens, model, source, duration_ms)
            VALUES (${s.task_id}, ${s.run_id}, 'compact', ${s.at}, ${s.tokens}, ${s.post_tokens}, ${s.max_tokens}, ${s.model}, ${s.source}, ${s.duration_ms})`.pipe(
          Effect.asVoid,
          Effect.orDie,
        )

      const detailOf = SqlSchema.findAll({
        Request: Schema.String,
        Result: Detail,
        execute: (task) => sql`SELECT context_detail FROM tasks WHERE id = ${task}`,
      })
      const detail = (task: TaskId) =>
        detailOf(task).pipe(
          Effect.map((rows) => rows[0]?.context_detail ?? null),
          Effect.orDie,
        )

      const setDetail = (task: TaskId, text: string | null) =>
        sql`UPDATE tasks SET context_detail = ${text} WHERE id = ${task}`.pipe(Effect.asVoid, Effect.orDie)

      return ContextStatsRepo.of({ turnUsage, compactedTurn, takeTurn, insertTurn, insertCompaction, detail, setDetail })
    }),
  )
}
