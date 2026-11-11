import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import { FAKE_CODEX, TestPlatform } from "@huntaway/testing"
import { AgentConfigRepo } from "../../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../../profiles/AgentConfigRepo.ts"
import { CodexQueries } from "../CodexQueries.ts"
import { CodexQueriesLive } from "./CodexQueriesLive.ts"
import { rateLimits, titleModel } from "./queries.ts"
import type { CodexModel } from "./queries.ts"

// The one-off questions to Codex (5.3) against fake-codex (packages/testing/bin/fake-codex.ts), and the old
// agent/codex/tests.test.ts cases for what they read: rate limit windows, and the title's model.

const codex: AgentConfigRow = {
  id: AgentConfigId.make("cx"),
  name: "Codex",
  config_dir: "~/.codex-test",
  agent: "codex",
  show_usage: true,
  restart_window: false,
  api_url: null,
  has_api_key: false,
  has_management_key: false,
  created_at: Timestamp.make("2026-11-12T00:00:00.000Z"),
}

/** The live queries over a test platform (which has Node's services) whose Codex is `codexBin`. */
const live = <A, E>(effect: Effect.Effect<A, E, CodexQueries | AgentConfigRepo>, codexBin = FAKE_CODEX) =>
  effect.pipe(Effect.provide(CodexQueriesLive.pipe(Layer.provideMerge(AgentConfigRepo.layer), Layer.provideMerge(TestPlatform({ codexBin })))))

const ids = (rl: unknown) => rateLimits(rl).map((l) => [l.id, l.label])
const window = (mins: number | null) => ({ usedPercent: 10, windowDurationMins: mins, resetsAt: 1793521800 })
const model = (id: string, description: string, is_default = false, efforts = ["low", "medium", "high"]): CodexModel => ({
  id,
  name: id,
  description,
  is_default,
  efforts,
  default_effort: "medium",
})

describe("CodexQueries against fake-codex", () => {
  it.live("lists a config's models, skills and rate limits", () =>
    live(
      Effect.gen(function* () {
        const queries = yield* CodexQueries
        const models = yield* queries.models(codex)
        assert.deepStrictEqual(
          models.map((m) => [m.id, m.is_default]),
          [
            ["gpt-fake", true],
            ["gpt-fake-mini", false],
          ],
        )
        const skills = yield* queries.skills(codex, null)
        assert.deepStrictEqual(
          skills.map((s) => s.name),
          ["fake-skill"],
        )
        const limits = yield* queries.rateLimits(codex)
        assert.strictEqual(limits.plan, "plus")
        assert.deepStrictEqual(
          limits.limits.map((l) => l.id),
          ["session", "weekly"],
        )
      }),
    ),
  )

  it.live("writes a title with the config's cheapest model, at low effort", () =>
    live(
      Effect.gen(function* () {
        const answer = yield* (yield* CodexQueries).title(codex, "/", "Write a title.", "<task>\nx\n</task>")
        assert.isTrue(Result.isSuccess(answer.reply))
        assert.isNotNull(answer.spent)
      }),
    ),
  )

  it.live("configs.models: a Codex config's models; a Claude config's none; a config that isn't there is not found", () =>
    live(
      Effect.gen(function* () {
        const repo = yield* AgentConfigRepo
        const queries = yield* CodexQueries
        yield* repo.insert(codex.id, codex.created_at, { name: "Codex", config_dir: codex.config_dir, agent: "codex" })
        yield* repo.insert(AgentConfigId.make("cl"), codex.created_at, { name: "Claude", config_dir: "", agent: "claude" })
        assert.deepStrictEqual(
          (yield* queries.configModels(codex.id)).map((m) => m.id),
          ["gpt-fake", "gpt-fake-mini"],
        )
        assert.deepStrictEqual(yield* queries.configModels(AgentConfigId.make("cl")), [])
        assert.strictEqual((yield* queries.configModels(AgentConfigId.make("gone")).pipe(Effect.flip))._tag, "AgentConfigNotFound")
      }),
    ),
  )

  it.live("a Codex that isn't there is unavailable", () =>
    live(
      Effect.gen(function* () {
        const failed = yield* (yield* CodexQueries).models(codex).pipe(Effect.flip)
        assert.strictEqual(failed._tag, "CodexUnavailable")
      }),
      "/nonexistent/codex",
    ),
  )
})

describe("what Codex's answers say", () => {
  it("rate limit windows go by their length", () => {
    const w = window
    assert.deepStrictEqual(ids({ primary: w(300), secondary: w(10080) }), [
      ["session", "Session"],
      ["weekly", "Weekly"],
    ])
    // A weekly-only plan's primary window is its weekly one.
    assert.deepStrictEqual(ids({ primary: w(10080), secondary: null }), [["weekly", "Weekly"]])
    assert.deepStrictEqual(ids({ primary: w(null), secondary: w(null) }), [
      ["session", "Session"],
      ["weekly", "Weekly"],
    ])
    assert.deepStrictEqual(ids({ primary: w(120), secondary: w(43200) }), [
      ["window:120", "2-hour"],
      ["window:43200", "30-day"],
    ])
  })

  it("titles use a cheap model at low effort", () => {
    const m = model
    // HA-196: the config's default here is its biggest model.
    const list = [
      m("gpt-6.1-sol", "Most capable model for hard work.", true),
      m("gpt-5.6-luna", "Older fast and efficient model."),
      m("gpt-6-luna", "Fast and affordable model for easier tasks."),
      m("gpt-6-codex-mini", "", false, ["medium", "high"]),
    ]
    assert.deepStrictEqual(titleModel(list), { model: "gpt-6-luna", effort: "low" })
    // The default when it's a cheap one; by its name when it doesn't say; the least effort when it can't do low.
    const [sol, , , mini] = list
    assert.deepStrictEqual(titleModel([mini ?? list[0] ?? m("", ""), m("gpt-6-luna", "Fast and affordable model.", true)]), {
      model: "gpt-6-luna",
      effort: "low",
    })
    assert.deepStrictEqual(titleModel([sol ?? m("", ""), mini ?? m("", "")]), { model: "gpt-6-codex-mini", effort: "medium" })
    // None that's cheap: the config's default.
    assert.deepStrictEqual(titleModel([sol ?? m("", "")]), { model: null, effort: "low" })
    assert.deepStrictEqual(titleModel([]), { model: null, effort: "low" })
  })
})
