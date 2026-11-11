import { assert, describe, it } from "@effect/vitest"
import type { Decision, Rules } from "@huntaway/shared"
import { DESKTOP_READS } from "../claude/access.ts"
import { defaultRuleSet } from "../rules.ts"
import { codexPolicy, codexServer, mcpServerConfig, needsUserReviewer, ownTools } from "./servers.ts"
import { policy } from "./spec.ts"

// The approval rules on a Codex run (huntaway's agent/approval_rules/tests.test.ts, its Codex cases): its servers'
// configs ask, approve or turn off what the rules say, and the rules on its own tools change its policy, or refuse it.

const rules = (list: ReadonlyArray<readonly [string, Decision]>): Rules => ({ rules: list.map(([tool, decision]) => ({ tool, decision })), expiry_minutes: 30 })

/** A config's tools, by name. */
const toolsOf = (cfg: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> => {
  const t = cfg?.["tools"]
  return typeof t === "object" && t !== null ? { ...t } : {}
}

/** The desktop server's config, as a run starts with it. */
const cfg = () => mcpServerConfig("desktop", { type: "http", url: "u" }, false, [], false) ?? {}

/** A run's policy in `mode` with `r`, or why it doesn't run. */
const of = (r: Rules | null, mode: string) => {
  const got = codexPolicy(r, policy(mode, false))
  return "policy" in got ? got.policy : got.refused
}

describe("approval rules on a Codex run", () => {
  it("Codex asks about every call of a server a rule may match", () => {
    const r = rules([
      ["mcp__g__get*", "allow"],
      ["mcp__g__read_mail", "allow"],
      ["mcp__g__send_mail", "ask"],
      ["mcp__g__delete_mail", "never"],
      ["mcp__off", "never"],
    ])
    const g = codexServer(r, "g", { command: "g", default_tools_approval_mode: "approve", disabled_tools: ["x"] })
    assert.strictEqual(g?.["default_tools_approval_mode"], "prompt")
    assert.deepStrictEqual(toolsOf(g), { read_mail: { approval_mode: "approve" }, send_mail: { approval_mode: "prompt" } })
    assert.deepStrictEqual(g?.["disabled_tools"], ["x", "delete_mail"])
    // A server a never rule names is left out.
    assert.isNull(codexServer(r, "off", {}))
    // One no rule may match is as it was.
    assert.deepStrictEqual(codexServer(r, "other", { command: "o" }), { command: "o" })
    // A pattern may match any server's tools.
    assert.strictEqual(codexServer(rules([["*delete*", "never"]]), "other", {})?.["default_tools_approval_mode"], "prompt")
    // Only allow rules: nothing asks that didn't before.
    assert.deepStrictEqual(
      codexServer(
        rules([
          ["mcp__g__get_mail", "allow"],
          ["mcp__g__list*", "allow"],
        ]),
        "g",
        {},
      ),
      { tools: { get_mail: { approval_mode: "approve" } } },
    )
    // An exact allow that a stronger pattern overrules isn't approved up front.
    const overruled = codexServer(
      rules([
        ["mcp__g__delete_draft", "allow"],
        ["mcp__g__*delete*", "never"],
      ]),
      "g",
      {},
    )
    assert.deepStrictEqual(toolsOf(overruled), {})
    // The board's own server is the board's to hold.
    assert.deepStrictEqual(codexServer(rules([["*", "never"]]), "huntaway", {}), {})
    assert.isTrue(needsUserReviewer(r))
    assert.isFalse(needsUserReviewer(rules([["mcp__g__get*", "allow"]])))
  })

  // HA-407's review: the desktop server's config approves its reads up front, which a rule that asks or refuses them
  // has to undo on a Codex run, as the hook does on a Claude one.
  it("a rule that asks undoes a Codex server's approved tools", () => {
    for (const pattern of ["mcp__desktop__*", "mcp__desktop", "mcp__*", "*"]) {
      const c = codexServer(rules([[pattern, "ask"]]), "desktop", cfg())
      assert.strictEqual(c?.["default_tools_approval_mode"], "prompt", pattern)
      for (const t of DESKTOP_READS) assert.notDeepEqual(toolsOf(c)[t], { approval_mode: "approve" }, `${pattern}: ${t}`)
    }
    // A rule about one tool leaves the others' approvals, as a Claude run's --allowedTools does; an allow keeps its own.
    const one = codexServer(
      rules([
        ["mcp__desktop__screen", "never"],
        ["mcp__desktop__zoom", "ask"],
        ["mcp__desktop__read", "allow"],
      ]),
      "desktop",
      cfg(),
    )
    assert.strictEqual(toolsOf(one)["screen"], undefined)
    assert.deepStrictEqual(toolsOf(one)["zoom"], { approval_mode: "prompt" })
    assert.deepStrictEqual(toolsOf(one)["read"], { approval_mode: "approve" })
    assert.deepStrictEqual(toolsOf(one)["windows"], { approval_mode: "approve" })
    const disabled = one?.["disabled_tools"]
    assert.isTrue(Array.isArray(disabled) && disabled.includes("screen"))
    // Only allow rules: the reads stay approved.
    const allowed = codexServer(rules([["mcp__desktop__act", "allow"]]), "desktop", cfg())
    for (const t of DESKTOP_READS) assert.deepStrictEqual(toolsOf(allowed)[t], { approval_mode: "approve" }, t)
  })

  it("Codex asks about its own tools for an ask rule and won't run with a never rule", () => {
    assert.deepStrictEqual(ownTools(defaultRuleSet()), { asks: false })
    assert.deepStrictEqual(
      ownTools(
        rules([
          ["mcp__g__x", "never"],
          ["Bash", "ask"],
        ]),
      ),
      { asks: true },
    )
    assert.deepStrictEqual(ownTools(rules([["Bash", "allow"]])), { asks: false })
    for (const never of ["Bash", "*", "ApplyPatch"]) {
      const got = ownTools(rules([[never, "never"]]))
      assert.isTrue("refused" in got && got.refused.includes(`"${never}: never"`) && got.refused.includes("Claude config"), never)
    }
  })

  it("Codex runs with rules on their own tools ask whatever their mode", () => {
    // No rules: as the mode has it.
    assert.deepStrictEqual(of(null, "bypassPermissions"), ["never", "user", "danger-full-access"])
    assert.deepStrictEqual(of(null, "auto"), ["on-request", "auto_review", "workspace-write"])
    // Rules for MCP tools only: the user answers rather than Codex's reviewer, the policy stays.
    const mcp = rules([["mcp__g__send*", "ask"]])
    assert.deepStrictEqual(of(mcp, "auto"), ["on-request", "user", "workspace-write"])
    assert.deepStrictEqual(of(mcp, "bypassPermissions"), ["never", "user", "danger-full-access"])
    // An ask rule on Bash: Codex asks about every command it doesn't take as safe, in Bypass too, and without full
    // access; in plan mode its sandbox stays read-only.
    const bash = rules([["Bash", "ask"]])
    for (const mode of ["bypassPermissions", "dontAsk", "auto", "acceptEdits", "default"]) {
      assert.deepStrictEqual(of(bash, mode), ["untrusted", "user", "workspace-write"], mode)
    }
    assert.deepStrictEqual(of(bash, "plan"), ["untrusted", "user", "read-only"])
    // Never on Bash: it doesn't run.
    assert.isTrue("refused" in codexPolicy(rules([["Bash", "never"]]), policy("default", false)))
  })
})
