import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AgentConfigId, TaskId } from "@huntaway/contracts"
import { fakeTask, TestBoard } from "@huntaway/testing"
import { SideCalls } from "./SideCalls.ts"
import type { Spent } from "./tokens/calls.ts"
import { counts } from "./tokens/counts.ts"

// The old agent/tokens/calls.test.ts's "calls are in the token report of their tasks or their config's profile", at
// the rows: the report (`analytics`, 6.9) is not here yet, so what it would read is checked in `call_usage` itself.

const run = <A, E>(effect: Effect.Effect<A, E, SideCalls | SqlClient.SqlClient | SecureRandom.SecureRandom>) =>
  effect.pipe(Effect.provide(SideCalls.layer.pipe(Layer.provideMerge(TestBoard()))))

const spent = (output: number): Spent => ({ runtime: "claude", models: { haiku: counts({ output, cost: 0.01 }) } })

describe("SideCalls", () => {
  it.effect("a call's rows: one for each model it used, sharing its id, for its task or its config", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* SideCalls
        const sql = yield* SqlClient.SqlClient
        const task = yield* fakeTask
        const cfg = AgentConfigId.make("a")
        const other = AgentConfigId.make("b")
        yield* calls.record("title", task, cfg, spent(1))
        yield* calls.record("window", null, cfg, spent(2))
        yield* calls.record("window", null, other, spent(4))
        // Nothing used: no row.
        yield* calls.record("window", null, cfg, { runtime: "claude", models: { haiku: counts() } })
        // A task deleted while its title was written: no row.
        yield* calls.record("title", TaskId.make("gone"), null, spent(16))
        // A call on two models, and another just like it: a row for each model, which share their call's id.
        const two: Spent = { runtime: "claude", models: { haiku: counts({ output: 32 }), opus: counts({ output: 64 }) } }
        yield* calls.record("window", null, other, two)
        yield* calls.record("window", null, other, two)

        const twice = yield* sql<{ readonly call_id: string }>`SELECT call_id FROM call_usage WHERE output_tokens >= 32`
        assert.strictEqual(twice.length, 4)
        assert.strictEqual(new Set(twice.map((r) => r.call_id)).size, 2)
        yield* sql`DELETE FROM call_usage WHERE output_tokens >= 32`
        const rows = () =>
          sql<{
            readonly purpose: string
            readonly task_id: string | null
            readonly config_id: string | null
            readonly output_tokens: number
            readonly cost_usd: number | null
          }>`SELECT purpose, task_id, config_id, output_tokens, cost_usd FROM call_usage ORDER BY output_tokens`.pipe(
            Effect.map((all) => all.map((r) => [r.purpose, r.task_id, r.config_id, r.output_tokens, r.cost_usd])),
          )
        assert.deepStrictEqual(yield* rows(), [
          ["title", task, "a", 1, 0.01],
          ["window", null, "a", 2, 0.01],
          ["window", null, "b", 4, 0.01],
        ])
        // Deleting the task takes its titles' rows.
        yield* sql`DELETE FROM tasks WHERE id = ${task}`
        assert.deepStrictEqual(
          (yield* rows()).map((r) => r[3]),
          [2, 4],
        )
      }),
    ),
  )
})
