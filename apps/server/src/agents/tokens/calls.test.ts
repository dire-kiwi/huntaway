import { assert, describe, it } from "@effect/vitest"
import { jsonText } from "../claude/tools.ts"
import { spentFromClaude, spentFromClaudeStream, spentFromCodex } from "./calls.ts"
import { counts } from "./counts.ts"

// The old agent/tokens/calls.test.ts's "reads what a call used". Its report case is ../SideCalls.test.ts.

describe("spentFrom…", () => {
  it("reads what a call used", () => {
    // What `claude -p --output-format json` prints (cut down).
    const r = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Fix login button",
      total_cost_usd: 0.0001565,
      modelUsage: {
        "claude-haiku-5-5": {
          inputTokens: 2,
          outputTokens: 67,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 614,
          cacheCreationEphemeral1hInputTokens: 600,
          cacheCreationEphemeral5mInputTokens: 14,
          costUSD: 0.0001565,
          thinkingTokens: 56,
          contextWindow: 1000000,
        },
      },
    }
    const c = counts({ input: 2, output: 67, cache_write: 614, cache_write_1h: 600, cache_write_5m: 14, reasoning: 56, cost: 0.0001565 })
    assert.deepStrictEqual(spentFromClaude(r), { runtime: "claude", models: { "claude-haiku-5-5": c } })
    // stream-json's last result, after the rest.
    const stream = `${jsonText({ type: "rate_limit_event" })}\n${jsonText({ type: "assistant", message: { content: "result" } })}\n${jsonText(r)}\n`
    assert.deepStrictEqual(spentFromClaudeStream(stream), spentFromClaude(r))
    assert.isNull(spentFromClaudeStream('{"type":"rate_limit_event"}\n'))
    // Codex counts cached input in the input.
    const u = { total: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 20, reasoningOutputTokens: 12 }, last: {} }
    const cx = counts({ input: 100, output: 20, cache_read: 800, reasoning: 12 })
    assert.deepStrictEqual(spentFromCodex("gpt-6.1-mini", u), { runtime: "codex", models: { "gpt-6.1-mini": cx } })
  })
})
