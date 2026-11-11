import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { readThreadScenario, threadScenarios } from "@huntaway/testing"
import { Effect, Result } from "effect"
import { decodeLine, type LineProblem } from "./lines.ts"
import { jsonText } from "./tools.ts"

const problem = (line: string): LineProblem | null => {
  const r = decodeLine(line)
  return Result.isFailure(r) ? r.failure : null
}

describe("decodeLine", () => {
  it("skips what is not one of Claude Code's lines the server reads, saying why", () => {
    assert.deepStrictEqual(problem("a line that is not JSON"), { _tag: "NotJson" })
    assert.deepStrictEqual(problem("[1, 2]"), { _tag: "NotJson" })
    assert.deepStrictEqual(problem(jsonText({ method: "turn/started", params: {} })), { _tag: "Codex" })
    assert.deepStrictEqual(problem(jsonText({ type: "system", subtype: "status", status: "requesting" })), {
      _tag: "Ignored",
      type: "system",
      subtype: "status",
    })
    assert.deepStrictEqual(problem(jsonText({ type: "future_message", detail: "?" })), { _tag: "Unknown", type: "future_message", subtype: null })
    assert.deepStrictEqual(problem(jsonText({ type: "system", subtype: "brand_new" })), { _tag: "Unknown", type: "system", subtype: "brand_new" })
    const malformed = problem(jsonText({ type: "assistant", message: { content: "not a list" } }))
    assert.deepStrictEqual(malformed?._tag === "Malformed" ? [malformed.type, malformed.subtype] : [], ["assistant", null])
    assert.strictEqual(problem(jsonText({ type: "result", subtype: "success", num_turns: "one" }))?._tag, "Malformed")
  })

  it("keeps the fields the server reads, and what a tool or the model says as it is", () => {
    const line = decodeLine(
      jsonText({
        type: "assistant",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          model: "claude-x",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", nested: [1, { a: null }] }, caller: { type: "direct" } },
            { type: "redacted_thinking", data: "…" },
            { type: "thinking", thinking: "hm", signature: "sig" },
          ],
          usage: { input_tokens: 2 },
          container: null,
          stop_details: null,
        },
        uuid: "u1",
        timestamp: "2026-11-01T00:00:00Z",
      }),
    )
    assert.deepStrictEqual(Result.getOrUndefined(line), {
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      uuid: "u1",
      message: {
        id: "m1",
        model: "claude-x",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", nested: [1, { a: null }] } },
          { type: "redacted_thinking" },
          { type: "thinking", thinking: "hm" },
        ],
        usage: { input_tokens: 2 },
      },
    })
  })

  it.effect("decodes every line of the recorded Claude sessions but those it means to skip", () =>
    Effect.gen(function* () {
      const problems = new Map<string, number>()
      let decoded = 0
      for (const scenario of (yield* threadScenarios).filter((s) => s.harness === "claude")) {
        for (const entry of (yield* readThreadScenario(scenario)).session) {
          if (entry["dir"] !== "out") continue
          const text = typeof entry["line"] === "string" ? entry["line"] : jsonText(entry["msg"])
          const r = decodeLine(text)
          if (Result.isSuccess(r)) decoded++
          else {
            const p = r.failure
            const key = p._tag === "Ignored" || p._tag === "Unknown" ? `${p._tag}:${p.type}/${p.subtype ?? ""}` : p._tag
            problems.set(key, (problems.get(key) ?? 0) + 1)
            if (p._tag === "Malformed") assert.fail(`${scenario.name}: ${p.type}/${p.subtype ?? ""}: ${p.issue}`)
          }
        }
      }
      assert.deepStrictEqual(Object.fromEntries(problems), {
        "Ignored:system/status": 56,
        "Ignored:system/hook_started": 2,
        "Ignored:system/hook_response": 2,
        "Ignored:system/api_retry": 2,
        "Ignored:system/thinking_tokens": 11,
        "Unknown:future_message/": 1,
        NotJson: 1,
      })
      assert.strictEqual(decoded, 848)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
