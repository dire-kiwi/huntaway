import { assert, describe, it } from "vite-plus/test"
import { BLOCKED, BOARD_SERVER_NAMES, decide, forMode, hookDecision, matches, parseRuleList } from "../src/approvalRules.ts"
import type { Decision, Rule, Rules } from "../src/approvalRules.ts"

// huntaway's agent/approval_rules/tests.test.ts, the matcher's and the hook's decision's cases. The defaults, the
// checks, Claude's hook entry and the action log are the server's (apps/server/src/agents/rules.test.ts,
// ApprovalRules.test.ts); the hook as a process is apps/server/src/hooks/approval-hook.test.ts.

const rule = (tool: string, decision: Decision): Rule => ({ tool, decision })
const rules = (list: ReadonlyArray<readonly [string, Decision]>): Rules => ({ rules: list.map(([t, d]) => rule(t, d)), expiry_minutes: 30 })
const decided = (r: Rules, tool: string): Decision | null => decide(r, tool)?.decision ?? null
const call = (tool: string) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { to: "bob@example.com" } })

describe("approval rules", () => {
  it("the board's server names, and the tools no rule holds for (questions and plans)", () => {
    assert.deepStrictEqual(BOARD_SERVER_NAMES, ["huntaway", "issue_agent", "issue-agent"])
    const all = rules([["*", "never"]])
    for (const t of ["AskUserQuestion", "request_user_input", "ExitPlanMode"]) assert.strictEqual(decided(all, t), null, t)
  })

  it("a rule names a tool, a server or a pattern", () => {
    assert.isTrue(matches("Bash", "Bash"))
    assert.isFalse(matches("Bash", "BashOutput"))
    assert.isTrue(matches("mcp__google__send_gmail_message", "mcp__google__send_gmail_message"))
    // A server's prefix is all its tools, and only its.
    assert.isTrue(matches("mcp__google", "mcp__google__send_gmail_message"))
    assert.isFalse(matches("mcp__google", "mcp__googlemaps__search"))
    assert.isFalse(matches("mcp__google__send", "mcp__google__send_gmail_message"))
    // Patterns, without regard to case.
    assert.isTrue(matches("mcp__google__*delete*", "mcp__google__delete_event"))
    assert.isTrue(matches("mcp__google__*Delete*", "mcp__google__gmail_deleteMessage"))
    assert.isTrue(matches("mcp__*__send*", "mcp__mail__send_now"))
    assert.isFalse(matches("mcp__google__*delete*", "mcp__other__delete_event"))
    assert.isTrue(matches("*", "anything"))
    assert.isFalse(matches("", "anything"))
    assert.isFalse(matches("a*b", "acbd"))
    assert.isTrue(matches("a*b*", "acbd"))
  })

  it("the strongest matching rule decides", () => {
    const r = rules([
      ["mcp__google", "allow"],
      ["mcp__google__*send*", "ask"],
      ["mcp__google__*delete*", "never"],
    ])
    assert.strictEqual(decided(r, "mcp__google__search"), "allow")
    assert.strictEqual(decided(r, "mcp__google__send_mail"), "ask")
    assert.strictEqual(decided(r, "mcp__google__send_then_delete"), "never")
    assert.strictEqual(decided(r, "Bash"), null)
    // Questions and plans are the user's whatever the rules.
    const all = rules([["*", "never"]])
    assert.strictEqual(decided(all, "AskUserQuestion"), null)
    assert.strictEqual(decided(all, "ExitPlanMode"), null)
    assert.strictEqual(decided(all, "request_user_input"), null)
  })

  it("plan mode takes no allow rules", () => {
    const r = rules([
      ["mcp__g__get*", "allow"],
      ["mcp__g__send*", "ask"],
      ["mcp__g__del*", "never"],
    ])
    assert.strictEqual(decided(forMode(r, "plan"), "mcp__g__get_mail"), null)
    assert.strictEqual(decided(forMode(r, "plan"), "mcp__g__send_mail"), "ask")
    assert.strictEqual(decided(forMode(r, "default"), "mcp__g__get_mail"), "allow")
  })

  it("rules are read from JSON as given, or not at all", () => {
    assert.deepStrictEqual(parseRuleList([{ tool: "Bash", decision: "never", extra: 1 }]), [rule("Bash", "never")])
    for (const bad of [{ rules: [] }, [{ tool: "x" }], [{ tool: "x", decision: "maybe" }], [{ tool: 1, decision: "ask" }], "Bash", null]) {
      assert.strictEqual(parseRuleList(bad), null, JSON.stringify(bad))
    }
  })

  it("the hook allows, asks or blocks by the rules", () => {
    const r = rules([
      ["mcp__g__get*", "allow"],
      ["mcp__g__send*", "ask"],
      ["mcp__g__del*", "never"],
      ["mcp__huntaway__create_task", "ask"],
    ])
    const out = (tool: string) => hookDecision(r, call(tool))?.hookSpecificOutput.permissionDecision ?? null
    assert.strictEqual(out("mcp__g__get_mail"), "allow")
    assert.strictEqual(out("mcp__g__send_mail"), "ask")
    assert.strictEqual(out("mcp__g__delete_mail"), "deny")
    // Nothing to say about the rest, nor about the board's tools, which the board decides itself.
    assert.strictEqual(out("mcp__g__other"), null)
    assert.strictEqual(out("mcp__huntaway__create_task"), null)
    const deny = hookDecision(r, call("mcp__g__delete_mail"))
    const reason = deny?.hookSpecificOutput.permissionDecisionReason ?? ""
    assert.isTrue(reason.startsWith(`${BLOCKED} (never: mcp__g__del*)`), reason)
    assert.strictEqual(deny?.hookSpecificOutput.hookEventName, "PreToolUse")
  })
})
