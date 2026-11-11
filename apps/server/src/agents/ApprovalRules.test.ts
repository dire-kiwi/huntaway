import { assert, layer } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId, RequestId } from "@huntaway/contracts"
import type { BoardEvent } from "@huntaway/contracts"
import { blockedReason } from "@huntaway/shared"
import type { Decision, Rule } from "@huntaway/shared"
import { TestBoard } from "@huntaway/testing"
import { Events } from "../platform/Events.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ApprovalRules } from "./ApprovalRules.ts"
import { blockedToolUses, defaultRuleSet } from "./rules.ts"

// The service's cases of huntaway's agent/approval_rules/tests.test.ts (rules hold for the assistant and threads under
// it; the calls the hook blocked go in the action log) and of api/thread.test.ts (the approval-rules and action-log
// routes), on the whole board's services.

const rule = (tool: string, decision: Decision): Rule => ({ tool, decision })
const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)

/** A thread row of the profile's in no project, as later milestones make them (the assistant, a thread under it). */
const insertTask = (profile: ProfileId, id: string, fields: { readonly task_type?: string; readonly parent_id?: string }, number: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO tasks ${sql.insert({ id, profile_id: profile, title: id, number, last_activity_at: "", created_at: "", updated_at: "", ...fields })}`.pipe(
      Effect.orDie,
    )
    const task = yield* (yield* TaskRepo).get(id)
    if (task === null) return yield* Effect.die(`no task ${id}`)
    return task
  })

/** A profile with its assistant, a thread under it, and a thread of its own. */
const board = (name: string) =>
  Effect.gen(function* () {
    const profile = (yield* (yield* Profiles).create({ name })).id
    const assistant = yield* insertTask(profile, `${name}-assistant`, { task_type: "assistant" }, 1)
    const child = yield* insertTask(profile, `${name}-child`, { parent_id: assistant.id }, 2)
    const other = yield* insertTask(profile, `${name}-other`, {}, 3)
    return { profile, assistant, child, other }
  })

layer(TestBoard())("ApprovalRules", (it) => {
  it.effect("rules hold for the assistant and threads under it; saved they're the profile's, reset the defaults", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const { profile, assistant, child, other } = yield* board("holds")
      assert.deepStrictEqual(yield* rules.forTask(assistant), defaultRuleSet())
      assert.deepStrictEqual(yield* rules.forTask(child), defaultRuleSet())
      assert.strictEqual(yield* rules.forTask(other), null)
      const mine = { rules: [rule("mcp__g", "ask")], expiry_minutes: 30 }
      yield* rules.set(profile, { rules: mine.rules })
      assert.deepStrictEqual(yield* rules.forTask(child), mine)
      yield* rules.set(profile, { reset: true })
      assert.deepStrictEqual(yield* rules.rules(profile), defaultRuleSet())
    }),
  )

  it.effect("decides a call by the rules in the thread's mode, and the board's tools under any of their names", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const { profile, assistant, other } = yield* board("decides")
      yield* rules.set(profile, {
        rules: [rule("mcp__g__get*", "allow"), rule("mcp__g__send*", "ask"), rule("mcp__issue_agent__delete_task", "never")],
      })
      assert.deepStrictEqual(yield* rules.decide(assistant, "mcp__g__get_mail", "default"), rule("mcp__g__get*", "allow"))
      // Plan mode takes no allow rules.
      assert.strictEqual(yield* rules.decide(assistant, "mcp__g__get_mail", "plan"), null)
      assert.deepStrictEqual(yield* rules.decide(assistant, "mcp__g__send_mail", "plan"), rule("mcp__g__send*", "ask"))
      // Questions are the user's; and a thread the rules don't hold for has none.
      assert.strictEqual(yield* rules.decide(assistant, "AskUserQuestion", "default"), null)
      assert.strictEqual(yield* rules.decide(other, "mcp__g__send_mail", "default"), null)
      assert.deepStrictEqual(yield* rules.decideBoardTool(assistant, "delete_task"), {
        name: "mcp__issue_agent__delete_task",
        rule: rule("mcp__issue_agent__delete_task", "never"),
      })
      assert.strictEqual(yield* rules.decideBoardTool(other, "delete_task"), null)
    }),
  )

  it.effect("a pattern twice isn't saved, and saved rules read back and decide as they were sent", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const { profile, assistant } = yield* board("twice")
      // Bash: never under Bash: allow (the dialog's Try a tool says never) isn't saved as allow: it isn't saved.
      const refused = yield* Effect.flip(rules.set(profile, { rules: [rule("Bash", "allow"), rule("bash", "never")] }))
      assert.strictEqual(refused._tag, "Invalid")
      if (refused._tag === "Invalid") assert.include(refused.reason, "more than one rule")
      assert.isTrue((yield* rules.get(profile)).is_default)
      yield* rules.set(profile, { rules: [rule("Bash", "never"), rule("mcp__g", "allow")] })
      assert.deepStrictEqual((yield* rules.get(profile)).rules, [rule("Bash", "never"), rule("mcp__g", "allow")])
      assert.strictEqual((yield* rules.decide(assistant, "Bash", "default"))?.decision, "never")
    }),
  )

  it.effect("the view: the defaults until saved, the expiry alone, a week at most, a reset, and an approval_rules event each", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const events = yield* Events
      const { profile } = yield* board("view")
      let v = yield* rules.get(profile)
      assert.deepStrictEqual(
        [v.is_default, v.expiry_minutes, v.board_server, v.google_server, v.create_task_tools],
        [true, 30, "huntaway", "google", ["create_task"]],
      )
      assert.deepStrictEqual(v.rules, v.defaults.rules)
      const watch = yield* events.watch(undefined)
      // Only the expiry: the rules stay the defaults' (saved now).
      v = yield* rules.set(profile, { expiry_minutes: 0 })
      assert.deepStrictEqual([v.is_default, v.expiry_minutes, v.rules.length], [false, 0, v.defaults.rules.length])
      assert.strictEqual(yield* tag(rules.set(profile, { expiry_minutes: 7 * 24 * 60 + 1 })), "Invalid")
      assert.strictEqual(yield* tag(rules.set(profile, { expiry_minutes: -1 })), "Invalid")
      v = yield* rules.set(profile, { reset: true })
      assert.isTrue(v.is_default)
      const seen = yield* watch.live.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e: BoardEvent) => (e.type === "approval_rules" ? [e.profile_id, e.rules.is_default, e.rules.expiry_minutes] : e.type)),
        [
          [profile, false, 0],
          [profile, true, 30],
        ],
      )
      // A profile that isn't there.
      const nope = ProfileId.make("nope")
      assert.strictEqual(yield* tag(rules.get(nope)), "ProfileNotFound")
      assert.strictEqual(yield* tag(rules.set(nope, { reset: true })), "ProfileNotFound")
      assert.strictEqual(yield* tag(rules.log({ profile_id: nope })), "ProfileNotFound")
    }).pipe(Effect.scoped),
  )

  it.effect("the calls the hook blocked go in the action log, and only those", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const { profile, assistant, other } = yield* board("blocked")
      const reason = blockedReason("mcp__google__*delete*file*")
      const results = {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: reason },
            // Another tool's failure isn't a block.
            { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "exit 1" }] },
          ],
        },
      }
      assert.deepStrictEqual(blockedToolUses(results), ["toolu_1"])
      yield* rules.blocked(assistant, "mcp__google__delete_drive_file", { file_id: "f1" })
      // Not another tool's output that quotes the reason (mail about the rules, say), nor a board tool's refusal, which
      // the board logs itself, nor a thread the rules don't hold for.
      yield* rules.set(profile, { rules: [...defaultRuleSet().rules, rule("mcp__huntaway__delete_task", "never")] })
      yield* rules.blocked(assistant, "mcp__google__search_gmail_messages", {})
      yield* rules.blocked(assistant, "mcp__huntaway__delete_task", {})
      yield* rules.blocked(other, "mcp__google__delete_drive_file", {})
      const log = yield* rules.log({ profile_id: profile, limit: 10 })
      assert.deepStrictEqual(
        log.map((a) => [a.task_id, a.tool_name, a.summary, a.rule, a.decision, a.outcome, a.answered_by, a.decided_at !== null]),
        [[assistant.id, "mcp__google__delete_drive_file", "file_id: f1", "mcp__google__*delete*file*", "never", "blocked", "rule", true]],
      )
    }),
  )

  it.effect("an ask waits in the log until its prompt is answered; the log is the profile's own, newest first", () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      const events = yield* Events
      const { profile, assistant } = yield* board("asked")
      const { profile: someone } = yield* board("someone")
      const watch = yield* events.watch(undefined)
      const request = RequestId.make("req-1")
      const asked = yield* rules.record({
        task: assistant,
        tool: "mcp__g__send_mail",
        input: { to: "bob" },
        rule: { tool: "mcp__g__send*", decision: "ask" },
        result: { request },
      })
      assert.deepStrictEqual([asked.outcome, asked.answered_by, asked.decided_at, asked.request_id], ["pending", null, null, request])
      yield* rules.record({
        task: assistant,
        tool: "mcp__g__send_other",
        input: {},
        rule: { tool: "mcp__g__send*", decision: "ask" },
        result: { outcome: "denied", by: "mode" },
      })
      yield* rules.settle(request, "allowed", "user")
      // Settled once: a second answer finds nothing pending.
      yield* rules.settle(request, "expired", "expiry")
      const seen = yield* watch.live.pipe(Stream.take(3), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e: BoardEvent) => (e.type === "approval_log" ? [e.profile_id, e.task_id, e.action.tool_name, e.action.outcome] : e.type)),
        [
          [profile, assistant.id, "mcp__g__send_mail", "pending"],
          [profile, assistant.id, "mcp__g__send_other", "denied"],
          [profile, assistant.id, "mcp__g__send_mail", "allowed"],
        ],
      )
      const log = yield* rules.log({ profile_id: profile })
      assert.deepStrictEqual(
        log.map((a) => [a.tool_name, a.outcome, a.answered_by]),
        [
          ["mcp__g__send_other", "denied", "mode"],
          ["mcp__g__send_mail", "allowed", "user"],
        ],
      )
      assert.deepStrictEqual(yield* rules.log({ profile_id: someone, limit: 5 }), [])
      assert.strictEqual((yield* rules.log({ profile_id: profile, limit: 1 })).length, 1)
    }).pipe(Effect.scoped),
  )
})
