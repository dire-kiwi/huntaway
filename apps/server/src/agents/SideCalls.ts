import { Context, DateTime, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import type { AgentConfigId, TaskId } from "@huntaway/contracts"
import { Telemetry } from "../platform/Telemetry.ts"
import type { Spent } from "./tokens/calls.ts"
import { sorted, splitColumns, total } from "./tokens/counts.ts"

// The tokens of the board's own model calls that are not runs (huntaway's agent/tokens/calls.ts), in `call_usage`:
// task titles (`Titles`) and the prompts that restart 5-hour windows (`UsageWindow`). Each call is counted as it ends,
// from what its reply says it used. Each also goes to telemetry as a `side_call` (6.9).

export type SideCallPurpose = "title" | "window"

export interface SideCallsShape {
  /**
   * Keep what a call for `purpose` used, for task `task` or with config `config`: a row for each model it used, which
   * share the call's id. Nothing for a model that used nothing, nor for a task deleted while the call ran. Logs rather
   * than fails: the call's own work is done.
   */
  readonly record: (purpose: SideCallPurpose, task: TaskId | null, config: AgentConfigId | null, spent: Spent) => Effect.Effect<void>
}

export class SideCalls extends Context.Service<SideCalls, SideCallsShape>()("huntaway-server/agents/SideCalls") {
  static readonly layer = Layer.effect(
    SideCalls,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const random = yield* SecureRandom.SecureRandom
      const telemetry = yield* Telemetry

      const record = Effect.fn("SideCalls.record")(function* (purpose: SideCallPurpose, task: TaskId | null, config: AgentConfigId | null, spent: Spent) {
        const at = DateTime.formatIso(yield* DateTime.now)
        // The call's rows (one for each model) share it, so they're counted as one call.
        const callId = yield* random.uuidV4()
        for (const [model, n] of Object.entries(sorted(spent.models))) {
          if (!(total(n) > 0 || n.cost > 0)) continue
          const [oneHour, fiveMinutes] = splitColumns(spent.runtime, n)
          yield* sql`INSERT INTO call_usage (at, purpose, task_id, config_id, model, runtime, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, cost_usd, call_id, cache_write_1h_tokens, cache_write_5m_tokens)
            SELECT ${at}, ${purpose}, ${task}, ${config}, ${model}, ${spent.runtime}, ${n.input}, ${n.output}, ${n.cache_read}, ${n.cache_write},
              ${n.reasoning}, ${spent.runtime === "claude" ? n.cost : null}, ${callId}, ${oneHour}, ${fiveMinutes}
            WHERE ${task} IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id = ${task})`.pipe(
            Effect.catchCause((cause) => Effect.logWarning(`tokens: purpose=${purpose} keeping a model call's tokens`, cause)),
          )
          // 6.9: telemetry's `side_call`: a task's call with its task, a config's with the first profile that sends and has it.
          const row = {
            ts: at,
            event: "side_call",
            kind: purpose,
            runtime: spent.runtime,
            model,
            input_tokens: n.input,
            output_tokens: n.output,
            cache_read_tokens: n.cache_read,
            cache_write_tokens: n.cache_write,
            reasoning_tokens: n.reasoning,
            cost_usd: spent.runtime === "claude" ? n.cost : 0,
          }
          if (task !== null) yield* telemetry.taskEvent(task, row)
          else if (config !== null) yield* telemetry.configEvent(config, row)
        }
      })

      return SideCalls.of({ record })
    }),
  )
}
