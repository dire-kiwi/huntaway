import { assert, describe, it } from "@effect/vitest"
import { jsonText } from "../claude/tools.ts"
import { countClaude, countCodex } from "./count.ts"
import type { Before, Counted, Earlier } from "./count.ts"
import { counts, writeSplit } from "./counts.ts"
import type { ByModel, Counts } from "./counts.ts"

// The old agent/tokens/tests.test.ts's cases of the counting itself, word for word in what they feed and expect. The
// ones that go through the database are in ../Tokens.test.ts.

const json = jsonText

const result = (session: string, models: unknown): string => json({ type: "result", subtype: "success", session_id: session, modelUsage: models })

const opus = (input: number, output: number, read: number, cost: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: 10,
  costUSD: cost,
  thinkingTokens: 1,
})

const tokenUsage = ([input, cached, output]: readonly [number, number, number]) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  totalTokens: input + output,
})

const usage = (thread: string, total: readonly [number, number, number], last: readonly [number, number, number]): string =>
  json({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: tokenUsage(total), last: tokenUsage(last) } } })

/** A snapshot saved before the cache writes' split was counted. */
const oldSnapshot: Earlier = () => ({
  totals: { "claude-opus-5-5": counts({ input: 1, output: 10, cache_read: 100, cache_write: 320, reasoning: 1, cost: 0.1 }) },
  tail: {},
})

/** A request's message after the last result, saying which cache its writes went to. */
const msg = (id: string, w1h: number, w5m: number) =>
  json({
    type: "assistant",
    message: {
      id,
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1,
        output_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: w1h + w5m,
        cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m },
      },
    },
  })

const none: Earlier = () => null
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
const clone = (b: Before): Before => structuredClone(b)
const model = (m: ByModel, name: string): Counts => m[name] ?? assert.fail(`no ${name} in ${json(m)}`)

/** An `assistant` message of request `id`, as Claude Code prints one for each of its content blocks. */
const reply = (id: string, name: string, input: number, output: number, parent: string | null): string =>
  json({
    type: "assistant",
    parent_tool_use_id: parent,
    message: {
      id,
      model: name,
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  })

const init = () => json({ type: "system", subtype: "init", session_id: "s1" })

/** Counts runs A, B, … of one session in turn, each going on from the one before, as the count of a run does. */
const inTurn = (runs: ReadonlyArray<ReadonlyArray<string>>): Array<Counted> => {
  let before: Before | null = null
  return runs.map((lines) => {
    const prev = before
    const c = countClaude(lines, () => (prev === null ? null : clone(prev)))
    // A run that saved no totals leaves its earlier run's.
    if (Object.keys(c.snapshot).length > 0) before = { totals: structuredClone(c.snapshot), tail: structuredClone(c.tail) }
    return c
  })
}

const outputs = (counted: ReadonlyArray<Counted>) => counted.map((c) => model(c.models, "claude-opus-5-5").output)

/** Opus's usage, as Claude Code that says which cache its writes went to has it. */
const opusSplit = (output: number, w1h: number, w5m: number) => ({
  ...opus(1, output, 100, 0.1),
  cacheCreationInputTokens: w1h + w5m,
  cacheCreationEphemeral1hInputTokens: w1h,
  cacheCreationEphemeral5mInputTokens: w5m,
})

describe("countClaude and countCodex", () => {
  it("a Claude run uses what its session's totals went up by", () => {
    const lines = [
      json({ type: "system", subtype: "init", session_id: "s1" }),
      `{"type":"assistant","message":{"usage":{"output_tokens":3}}}`,
      result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) }),
      // A turn that failed before the model answered: no modelUsage, so no count.
      json({ type: "result", subtype: "error_during_execution", session_id: "s1", modelUsage: {} }),
      result("s1", { "claude-opus-5-5": opus(7, 150, 3000, 1.5), "claude-haiku-5-5": opus(1, 2, 0, 0.01) }),
    ]
    const c = countClaude(lines, none)
    assert.deepStrictEqual(model(c.models, "claude-opus-5-5"), counts({ input: 7, output: 150, cache_read: 3000, cache_write: 10, reasoning: 1, cost: 1.5 }))
    assert.strictEqual(model(c.models, "claude-haiku-5-5").output, 2)
    assert.strictEqual(c.session, "s1")
    assert.strictEqual(model(c.snapshot, "claude-opus-5-5").output, 150)

    // A later run that resumes the session goes on from those totals.
    const snapshot = structuredClone(c.snapshot)
    const earlier: Earlier = (s) => (s === "s1" ? { totals: structuredClone(snapshot), tail: {} } : null)
    const next = countClaude([result("s1", { "claude-opus-5-5": opus(9, 200, 4000, 2.0), "claude-haiku-5-5": opus(1, 2, 0, 0.01) })], earlier)
    assert.strictEqual(model(next.models, "claude-opus-5-5").output, 50)
    assert.strictEqual(model(next.models, "claude-opus-5-5").cache_read, 1000)
    assert.isTrue(near(model(next.models, "claude-opus-5-5").cost, 0.5))
    // Haiku did nothing more in it.
    assert.isFalse("claude-haiku-5-5" in next.models)

    // A new session (a review round's) starts from nothing.
    const fresh = countClaude([result("s2", { "claude-opus-5-5": opus(1, 10, 100, 0.1) })], earlier)
    assert.strictEqual(model(fresh.models, "claude-opus-5-5").output, 10)

    // Totals that went down: Claude Code started counting again.
    const again = countClaude([result("s1", { "claude-opus-5-5": opus(1, 20, 100, 0.2) })], earlier)
    assert.strictEqual(model(again.models, "claude-opus-5-5").output, 20)
  })

  it("a Codex run counts each thread's increase", () => {
    const lines = [
      json({ method: "thread/started", params: { thread: { id: "main" } } }),
      json({ method: "huntaway/model", params: { threadId: "main", model: "gpt-6.1-sol" } }),
      usage("main", [100, 40, 10], [100, 40, 10]),
      usage("main", [300, 200, 30], [200, 160, 20]),
      // A subagent's thread, new in this run.
      usage("child", [50, 0, 5], [50, 0, 5]),
    ]
    const c = countCodex(lines, "codex", none)
    const m = model(c.models, "gpt-6.1-sol")
    // Cached input isn't counted as input.
    assert.deepStrictEqual([m.input, m.cache_read, m.output], [150, 200, 35])
    assert.strictEqual(model(c.snapshot, "main").output, 30)

    // Resumed: the thread says its old totals again first, then goes on.
    const snapshot = structuredClone(c.snapshot)
    const earlier: Earlier = (t) => (t in snapshot ? { totals: structuredClone(snapshot), tail: {} } : null)
    const next = countCodex([usage("main", [300, 200, 30], [200, 160, 20]), usage("main", [400, 250, 40], [100, 50, 10])], "gpt-6.1-sol", earlier)
    assert.strictEqual(model(next.models, "gpt-6.1-sol").output, 10)

    // Its totals went down (rolled back), or a resumed thread's earlier totals aren't known: just the latest request.
    const rolled = [usage("main", [120, 0, 12], [20, 0, 2])]
    assert.strictEqual(model(countCodex(rolled, "m", earlier).models, "m").output, 2)
    assert.strictEqual(model(countCodex(rolled, "m", none).models, "m").output, 2)
  })

  it("a Codex subagent's tokens go to its own model", () => {
    const lines = [
      json({ method: "huntaway/model", params: { threadId: "main", model: "gpt-6.1-sol" } }),
      json({
        method: "item/started",
        params: { threadId: "main", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], model: "gpt-6-luna" } },
      }),
      json({
        method: "item/started",
        params: { threadId: "main", item: { type: "subAgentActivity", kind: "started", agentThreadId: "hosted", model: "gpt-6-astra" } },
      }),
      usage("main", [100, 0, 10], [100, 0, 10]),
      usage("child", [1000, 0, 200], [1000, 0, 200]),
      usage("hosted", [50, 0, 7], [50, 0, 7]),
      // Spawned without a model: the run's.
      usage("other", [20, 0, 3], [20, 0, 3]),
    ]
    const c = countCodex(lines, "codex", none)
    assert.deepStrictEqual(
      Object.entries(c.models).map(([m, n]) => [m, n.output]),
      [
        ["gpt-6-astra", 7],
        ["gpt-6-luna", 200],
        ["gpt-6.1-sol", 13],
      ],
    )
  })

  it("a Claude run that ends without a result counts its requests", () => {
    const lines = [
      init(),
      reply("m1", "claude-opus-5-5", 1200, 10, null),
      // The same request's next content block, with more of its output.
      reply("m1", "claude-opus-5-5", 1200, 300, null),
      // A subagent's, and a synthetic message (an error) that wasn't sent to the model.
      reply("m2", "claude-haiku-5-5", 50, 5, "toolu_1"),
      reply("m3", "<synthetic>", 0, 0, null),
    ]
    const c = countClaude(lines, none)
    assert.deepStrictEqual(
      Object.entries(c.models).map(([m, n]) => [m, n.input, n.output]),
      [
        ["claude-haiku-5-5", 50, 5],
        ["claude-opus-5-5", 1200, 300],
      ],
    )
    assert.isTrue(c.estimated)
    assert.strictEqual(c.session, "s1")
    assert.strictEqual(model(c.tail, "claude-opus-5-5").output, 300)
  })

  it("a Claude run's requests after its last result count once", () => {
    const lines = [
      init(),
      reply("m1", "claude-opus-5-5", 5, 100, null),
      result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) }),
      // The next turn was stopped before its result.
      reply("m2", "claude-opus-5-5", 2, 40, null),
    ]
    const c = countClaude(lines, none)
    // m1 is in the result's totals; m2 is counted from its message.
    assert.strictEqual(model(c.models, "claude-opus-5-5").output, 140)
    assert.strictEqual(model(c.snapshot, "claude-opus-5-5").output, 140)
    assert.strictEqual(model(c.tail, "claude-opus-5-5").output, 40)
    const before: Before = { totals: structuredClone(c.snapshot), tail: structuredClone(c.tail) }

    // The next run resumes the session. Claude Code kept the stopped turn in its totals: it goes on from them.
    const earlier: Earlier = () => clone(before)
    const kept = countClaude([reply("m3", "claude-opus-5-5", 802, 30, null), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })], earlier)
    assert.strictEqual(model(kept.models, "claude-opus-5-5").output, 30)
    assert.isFalse(kept.estimated)
    // It didn't: it goes on from the totals before it, not from nothing.
    const lost = countClaude([result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })], earlier)
    assert.strictEqual(model(lost.models, "claude-opus-5-5").output, 30)
    assert.isFalse(lost.estimated)
  })

  it("a resumed Claude run with no result goes on from the session's totals", () => {
    const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })]
    // Killed before its result.
    const b = [init(), reply("m1", "claude-opus-5-5", 2, 40, null)]
    // Claude Code kept B's request in its totals.
    let c = [init(), reply("m3", "claude-opus-5-5", 802, 30, null), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })]
    assert.deepStrictEqual(outputs(inTurn([a, b, c])), [100, 40, 30])
    // It didn't: C goes on from A's totals.
    c = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })]
    const counted = inTurn([a, b, c])
    assert.deepStrictEqual(outputs(counted), [100, 40, 30])
    assert.isTrue(near(model(counted[2]?.models ?? {}, "claude-opus-5-5").cost, 0.5))

    // Two runs in a row with no result: their tails add up, and are taken away together if they weren't kept.
    const b2 = [init(), reply("m2", "claude-opus-5-5", 1, 20, null)]
    const kept = [init(), reply("m3", "claude-opus-5-5", 701, 30, null), result("s1", { "claude-opus-5-5": opus(9, 190, 2000, 1.5) })]
    const lost = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })]
    for (const [last, want] of [
      [kept, 30],
      [lost, 30],
    ] as const) {
      const all = inTurn([a, b, b2, last])
      assert.deepStrictEqual(outputs(all), [100, 40, 20, want])
      assert.strictEqual(model(all[2]?.tail ?? {}, "claude-opus-5-5").output, 60)
    }
  })

  it("a resumed Claude run goes on without an unkept tail on a model the session hadn't used", () => {
    const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })]
    // Killed before its result, after a request on a model A didn't use.
    const b = [init(), reply("m1", "claude-haiku-5-5", 2, 40, null)]
    // Claude Code didn't keep it: C's totals don't have that model.
    const c = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })]
    const counted = inTurn([a, b, c])
    assert.strictEqual(model(counted[1]?.models ?? {}, "claude-haiku-5-5").output, 40)
    assert.deepStrictEqual(
      Object.entries(counted[2]?.models ?? {}).map(([m, n]) => [m, n.output]),
      [["claude-opus-5-5", 30]],
    )
    assert.isTrue(near(model(counted[2]?.models ?? {}, "claude-opus-5-5").cost, 0.5))
  })

  it("a resumed Claude run's own requests say whether an unkept tail is in totals that go on from it", () => {
    // A's totals fed in 1015; B was killed after a request that fed in 102 and put out 40.
    const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })]
    const b = [init(), reply("m1", "claude-opus-5-5", 2, 40, null)]
    // C's request feeds in 1000 and puts out 100. Claude Code didn't keep B's: C's totals are A's and C's, which still
    // go on from A's and B's (200 output tokens, past 140).
    const lost = [init(), reply("m2", "claude-opus-5-5", 900, 100, null), result("s1", { "claude-opus-5-5": opus(905, 200, 1100, 1.5) })]
    // It did: they're all three's.
    const kept = [init(), reply("m2", "claude-opus-5-5", 900, 100, null), result("s1", { "claude-opus-5-5": opus(907, 240, 1200, 1.5) })]
    for (const c of [lost, kept]) {
      const counted = inTurn([a, b, c])
      assert.deepStrictEqual(outputs(counted), [100, 40, 100])
      assert.isFalse(counted[2]?.estimated)
      assert.isTrue(near(model(counted[2]?.models ?? {}, "claude-opus-5-5").cost, 0.5))
    }

    // Requests that don't match either (the totals have some that print no message) go with the closer, estimated.
    const unsure = [init(), reply("m2", "claude-opus-5-5", 600, 100, null), result("s1", { "claude-opus-5-5": opus(905, 200, 1100, 1.5) })]
    const counted = inTurn([a, b, unsure])
    assert.strictEqual(model(counted[2]?.models ?? {}, "claude-opus-5-5").output, 60)
    assert.isTrue(counted[2]?.estimated)
  })

  it("a Claude run counts its 1h and 5m cache writes", () => {
    const c = countClaude([result("s1", { "claude-opus-5-5": opusSplit(10, 300, 20) })], none)
    assert.deepStrictEqual(writeSplit(model(c.models, "claude-opus-5-5")), [300, 20])
    // A resumed run: what they went up by.
    const snapshot = structuredClone(c.snapshot)
    const earlier: Earlier = (s) => (s === "s1" ? { totals: structuredClone(snapshot), tail: {} } : null)
    const next = countClaude([result("s1", { "claude-opus-5-5": opusSplit(20, 350, 70) })], earlier)
    assert.deepStrictEqual(writeSplit(model(next.models, "claude-opus-5-5")), [50, 50])

    // Older Claude Code didn't say: not known, rather than none.
    assert.isNull(writeSplit(model(countClaude([result("s1", { "claude-opus-5-5": opus(1, 10, 100, 0.1) })], none).models, "claude-opus-5-5")))
    // Nor is it for a run that goes on from a snapshot saved before they were counted.
    assert.isNull(writeSplit(model(countClaude([result("s1", { "claude-opus-5-5": opusSplit(20, 350, 70) })], oldSnapshot).models, "claude-opus-5-5")))

    // Requests after the last result say theirs in their own usage.
    const tail = countClaude([result("s1", { "claude-opus-5-5": opusSplit(10, 300, 20) }), msg("m1", 40, 0), msg("m1", 40, 0), msg("m2", 0, 7)], none)
    assert.deepStrictEqual(writeSplit(model(tail.models, "claude-opus-5-5")), [340, 27])
  })
})
