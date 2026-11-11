import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { RunId, Timestamp } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import { fakeTask, TestBoard } from "@huntaway/testing"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { decodeLine } from "./claude/lines.ts"
import { jsonText } from "./claude/tools.ts"
import { ContextMeter } from "./ContextMeter.ts"
import type { RunRef } from "./ContextMeter.ts"
import { ContextStatsRepo } from "./ContextStatsRepo.ts"

// The old runner/output.test.ts's "follows how full the context is" and "records context sizes and compactions", at the
// meter: `feed` makes the calls the run's line handler makes for each line (below). The report's part of the second
// (`analytics.context_report`, 6.9) is not here yet; its rows are checked in `context_stats` itself.

const TestLive = ContextMeter.layer.pipe(Layer.provideMerge(ContextStatsRepo.layer), Layer.provideMerge(TestBoard()))
type Env = ContextMeter | TaskRepo | Threads | SqlClient.SqlClient | SecureRandom.SecureRandom

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.provide(TestLive))

/** A run of `task`, started now. */
const newRun = (task: TaskId, kind: RunRef["kind"] = "prompt") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const random = yield* SecureRandom.SecureRandom
    const id = RunId.make(yield* random.uuidV4())
    const at = Timestamp.make(DateTime.formatIso(yield* DateTime.now))
    yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES (${id}, ${task}, ${kind}, 'running', ${at})`
    const ref: RunRef = { id, task_id: task, kind, created_at: at }
    return ref
  }).pipe(Effect.orDie)

/**
 * What the line handler does with each line for the meter: an `assistant` message's usage; a `result`'s window, the
 * breakdown asked for (the line appended to `input`), and the turn recorded with what it cost (here the result's
 * `total_cost_usd`; the handler gives `RunRepo.addCost`'s share); a `control_response`; a compaction.
 */
const feed = (r: RunRef, lines: ReadonlyArray<unknown>, input: Array<string>) =>
  Effect.gen(function* () {
    const meter = yield* ContextMeter
    for (const value of lines) {
      const decoded = decodeLine(jsonText(value))
      if (Result.isFailure(decoded)) {
        assert.fail(`not a line: ${jsonText(decoded.failure)}`)
        continue
      }
      const line = decoded.success
      if (line.type === "assistant") yield* meter.onAssistant(r, line)
      else if (line.type === "result") {
        yield* meter.onResult(r.task_id, line)
        input.push(yield* meter.requestLine)
        yield* meter.recordTurn(r, line.total_cost_usd ?? null)
      } else if (line.type === "control_response") yield* meter.onControlResponse(r.task_id, line)
      else if (line.type === "system" && line.subtype === "compact_boundary") yield* meter.onCompacted(r, line.compact_metadata)
    }
  })

const result = (subtype: string, cost: number, more: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  session_id: "s",
  total_cost_usd: cost,
  ...more,
})

const reply = (parent: string | null, written: number) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: {
    model: "claude-x",
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 2, cache_creation_input_tokens: written, cache_read_input_tokens: 1000, output_tokens: 50 },
  },
})

/** An `assistant` message whose usage has no output count. */
const short = (written: number) => {
  const v = reply(null, written)
  return { ...v, message: { ...v.message, usage: { input_tokens: 2, cache_creation_input_tokens: written, cache_read_input_tokens: 1000 } } }
}

const lastRequest = (input: ReadonlyArray<string>) => {
  const decoded = decodeLine(input.at(-1) ?? "")
  if (Result.isFailure(decoded) || decoded.success.type !== "control_request") return assert.fail("no control request")
  return decoded.success
}

const compacted = (meta: Record<string, unknown>) => ({ type: "system", subtype: "compact_boundary", compact_metadata: meta })

describe("ContextMeter", () => {
  it.effect("follows how full the context is", () =>
    run(
      Effect.gen(function* () {
        const meter = yield* ContextMeter
        const tasks = yield* TaskRepo
        const task = yield* fakeTask
        const r = yield* newRun(task)
        const input: Array<string> = []
        const ctx = Effect.map(tasks.get(task), (t) => t?.context ?? assert.fail("no context"))

        yield* feed(r, [reply(null, 500)], input)
        assert.deepStrictEqual([(yield* ctx).tokens, (yield* ctx).max_tokens], [1502, null])
        // A subagent's context is its own.
        yield* feed(r, [reply("toolu_sub", 90_000)], input)
        assert.strictEqual((yield* ctx).tokens, 1502)

        // The turn's end gives the model's window, and asks for the breakdown.
        yield* feed(r, [result("success", 0.1, { modelUsage: { "claude-haiku": { contextWindow: 1000 }, "claude-x": { contextWindow: 200_000 } } })], input)
        assert.strictEqual((yield* ctx).max_tokens, 200_000)
        const ask = lastRequest(input)
        assert.strictEqual(ask.request.subtype, "get_context_usage")
        // Not the full recount, which calls the token-counting API.
        assert.isTrue((input.at(-1) ?? "").includes('"detail":"summary"'))
        assert.isNull((yield* ctx).detail_at)

        // Other control responses aren't breakdowns.
        yield* feed(r, [{ type: "control_response", response: { subtype: "success", request_id: "stop-1", response: { totalTokens: 5 } } }], input)
        assert.strictEqual((yield* ctx).tokens, 1502)
        const breakdown = {
          categories: [{ id: "messages", name: "Messages", tokens: 600, kind: "used" }],
          totalTokens: 1600,
          maxTokens: 1_000_000,
          autoCompactThreshold: 967_000,
          isAutoCompactEnabled: true,
          model: "claude-x",
          gridRows: [[{ color: "x" }]],
        }
        yield* feed(r, [{ type: "control_response", response: { subtype: "success", request_id: ask.request_id, response: breakdown } }], input)
        const c = yield* ctx
        assert.deepStrictEqual([c.tokens, c.max_tokens, c.compact_at, c.model], [1600, 1_000_000, 967_000, "claude-x"])
        assert.isNotNull(c.detail_at)
        const got = yield* meter.get(task)
        assert.strictEqual(jsonText(got.detail).includes('"tokens":600'), true)
        assert.isFalse(jsonText(got.detail).includes("gridRows"))

        // Compacting starts again from the summary.
        yield* feed(r, [compacted({ trigger: "auto", pre_tokens: 1600, post_tokens: 300 })], input)
        assert.deepStrictEqual([(yield* ctx).tokens, (yield* ctx).max_tokens], [300, 1_000_000])

        // A new session forgets it.
        yield* meter.clear(task)
        assert.deepStrictEqual(yield* meter.get(task), { context: null, detail: null })
      }),
    ),
  )

  it.effect("records context sizes and compactions", () =>
    run(
      Effect.gen(function* () {
        const meter = yield* ContextMeter
        const sql = yield* SqlClient.SqlClient
        const threads = yield* Threads
        const task = yield* fakeTask
        const r = yield* newRun(task)
        const input: Array<string> = []
        const stats = () =>
          sql<{
            readonly run_id: string
            readonly kind: string
            readonly tokens: number | null
            readonly post_tokens: number | null
            readonly source: string | null
            readonly cost_usd: number | null
            readonly start_tokens: number | null
          }>`SELECT run_id, kind, tokens, post_tokens, source, cost_usd, start_tokens FROM context_stats ORDER BY id`
        const rows = Effect.map(stats(), (all) => all.map((s) => [s.run_id, s.kind, s.tokens, s.post_tokens, s.source, s.cost_usd]))
        const starts = Effect.map(stats(), (all) => all.filter((s) => s.kind === "turn").map((s) => s.start_tokens))

        // Each turn's end records the context it started from (its first request) and leaves, and what it cost.
        yield* feed(r, [short(100), short(500), result("success", 0.25)], input)
        assert.deepStrictEqual(yield* rows, [[r.id, "turn", 1502, null, null, 0.25]])
        assert.deepStrictEqual(yield* starts, [1102])
        // The breakdown asked for at the turn's end changes the task's context, but a turn the model then didn't answer
        // isn't one to count.
        const ask = lastRequest(input)
        const breakdown = { totalTokens: 1600, maxTokens: 200_000, model: "claude-x" }
        yield* feed(r, [{ type: "control_response", response: { subtype: "success", request_id: ask.request_id, response: breakdown } }], input)
        yield* feed(r, [result("error_during_execution", 0.25)], input)
        assert.strictEqual((yield* rows).length, 1)
        // A session started afresh on the thread (as reviews and summaries do) starts small, whatever the last turn left.
        yield* feed(r, [short(10), result("success", 0.3)], input)
        assert.deepStrictEqual(
          (yield* rows).map((s) => s[2]),
          [1502, 1012],
        )
        assert.deepStrictEqual(yield* starts, [1102, 1012])

        // The agent compacting by itself mid-turn.
        yield* feed(r, [compacted({ trigger: "auto", pre_tokens: 1600, post_tokens: 300 })], input)
        assert.deepStrictEqual((yield* rows)[2], [r.id, "compact", 1600, 300, "auto", null])
        // A compaction alone isn't a turn either.
        yield* feed(r, [result("success", 0.0)], input)
        assert.strictEqual((yield* rows).length, 3)

        // The board's `/compact` after the session sat idle, and the user's.
        const manual = { trigger: "manual", pre_tokens: 300, post_tokens: 100 }
        const idle = yield* newRun(task, "compact")
        yield* meter.onCompacted(idle, manual)
        const user = yield* newRun(task, "compact")
        yield* threads.userMessage(task, "/compact", {})
        yield* meter.onCompacted(user, manual)
        // Without `pre_tokens` (Codex), it's the latest count.
        yield* meter.onCompacted(user, { trigger: "manual" })
        assert.deepStrictEqual(
          (yield* rows).slice(3).map((s) => [s[0], s[2], s[4]]),
          [
            [idle.id, 300, "idle"],
            [user.id, 300, "user"],
            [user.id, 100, "user"],
          ],
        )
        // A `/compact`'s turn isn't one of the agent's.
        yield* meter.recordTurn(user, 0.01)
        assert.strictEqual((yield* rows).length, 6)
      }),
    ),
  )
})
