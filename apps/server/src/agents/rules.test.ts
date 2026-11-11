import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { spawnSync } from "node:child_process"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tempDir } from "@huntaway/testing"
import { toJson } from "../platform/columns.ts"
import { blockedReason, decide, HOOK_FAILED, matches, parseRuleList } from "@huntaway/shared"
import type { Decision, Rule, Rules } from "@huntaway/shared"
import {
  blockedToolUses,
  boardRule,
  checkRules,
  claudeDisallowed,
  claudeHook,
  claudeMatcher,
  defaultRuleSet,
  ghHook,
  GOOGLE_SERVER,
  hookSettings,
  MAX_EXPIRY_MINUTES,
  needsPromptTool,
  summarize,
} from "./rules.ts"

// huntaway's agent/approval_rules/tests.test.ts: the defaults, the checks before saving, the action log's summary, and
// what a Claude run gets to hold the rules. The Codex cases come with Codex (5.3); the matcher's are
// packages/shared/test/approvalRules.test.ts.

const rule = (tool: string, decision: Decision): Rule => ({ tool, decision })
const rules = (list: ReadonlyArray<readonly [string, Decision]>): Rules => ({ rules: list.map(([t, d]) => rule(t, d)), expiry_minutes: 30 })
const decided = (r: Rules, tool: string): Decision | null => decide(r, tool)?.decision ?? null

/** The launcher, as `HUNTAWAY_EXE` names it. */
const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url))

/** A hook's command, run by the shell as Claude Code runs it, with `input` on stdin. */
const runCommand = (command: string, input = "") => spawnSync("sh", ["-c", command], { input, encoding: "utf8" })

/** JSON text read as `schema`. */
const fromJson = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))

const HookAnswer = Schema.Struct({ hookSpecificOutput: Schema.Struct({ permissionDecision: Schema.String }) })
const Settings = Schema.Struct({ hooks: Schema.Struct({ PreToolUse: Schema.Array(Schema.Unknown) }) })

const refused = (r: Rules) => Effect.map(Effect.flip(checkRules(r)), (e) => e.reason)

const hookOf = (exe: string, r: Rules) =>
  Effect.map(claudeHook(exe, r), (hook) => {
    assert.isNotNull(hook)
    return hook?.hooks[0]?.command ?? ""
  })

describe("approval rules on the server", () => {
  it("the Google defaults: read and draft, ask to send, never delete", () => {
    const r = defaultRuleSet()
    const g = (t: string) => decided(r, `mcp__google__${t}`)
    for (const t of [
      "search_gmail_messages",
      "get_gmail_message_content",
      "list_calendars",
      "get_events",
      "search_drive_files",
      "get_drive_file_content",
      "draft_gmail_message",
      "list_drive_items",
      "get_drive_file_permissions",
    ]) {
      assert.strictEqual(g(t), "allow", t)
    }
    for (const t of [
      "send_gmail_message",
      "create_event",
      "modify_event",
      "delete_event",
      "share_drive_file",
      "modify_gmail_message_labels",
      "batch_modify_gmail_message_labels",
      "update_drive_permission",
      "manage_event",
      "update_drive_file",
      "create_gmail_filter",
      "transfer_drive_ownership",
      "manage_gmail_label",
    ]) {
      assert.strictEqual(g(t), "ask", t)
    }
    for (const t of ["delete_gmail_message", "trash_gmail_message", "delete_drive_file", "trash_drive_file", "gmail_deleteMessage"])
      assert.strictEqual(g(t), "never", t)
    // Another server's tools, and the board's, are left to the thread's mode.
    assert.strictEqual(decided(r, "mcp__other__send_gmail_message"), null)
    assert.strictEqual(decided(r, "mcp__huntaway__create_task"), null)
    assert.strictEqual(r.expiry_minutes, 30)
  })

  // workspace-mcp 2.3.0's Gmail, Calendar and Drive tools at its `extended` tier, as the assistant's Google server
  // serves them: reading and drafting are allowed, sending, sharing and changing ask, and making a file or a calendar is
  // left to the thread's mode. A new version of the server is checked against this.
  it("the Google defaults fit the Google server's own tools", () => {
    const r = defaultRuleSet()
    const g = (t: string) => decided(r, `mcp__${GOOGLE_SERVER}__${t}`)
    const allow = [
      "search_gmail_messages",
      "get_gmail_message_content",
      "get_gmail_messages_content_batch",
      "get_gmail_attachment_content",
      "get_gmail_thread_content",
      "list_gmail_labels",
      "draft_gmail_message",
      "list_gmail_filters",
      "list_calendars",
      "get_events",
      "query_freebusy",
      "search_drive_files",
      "get_drive_file_content",
      "get_drive_file_download_url",
      "list_drive_items",
    ]
    for (const t of allow) assert.strictEqual(g(t), "allow", t)
    const ask = [
      "send_gmail_message",
      "modify_gmail_message_labels",
      "manage_gmail_label",
      "manage_gmail_filter",
      "manage_event",
      "manage_out_of_office",
      "manage_focus_time",
      "update_drive_file",
      "manage_drive_access",
      "set_drive_file_permissions",
      // It reads a link, but may make the file shareable to give one.
      "get_drive_shareable_link",
    ]
    for (const t of ask) assert.strictEqual(g(t), "ask", t)
    for (const t of ["create_drive_file", "create_drive_folder", "copy_drive_file", "import_to_google_doc", "create_calendar"])
      assert.strictEqual(g(t), null, t)
  })

  it.effect("rules are tidied and checked for saving", () =>
    Effect.gen(function* () {
      const r = yield* checkRules(
        rules([
          [" mcp__a ", "allow"],
          ["", "ask"],
          ["mcp__b", "ask"],
        ]),
      )
      assert.deepStrictEqual(r.rules, [rule("mcp__a", "allow"), rule("mcp__b", "ask")])
      // A pattern twice is refused, whatever its case or decisions, rather than one of them dropped.
      const dups: ReadonlyArray<ReadonlyArray<readonly [string, Decision]>> = [
        [
          ["Bash", "allow"],
          ["Bash", "never"],
        ],
        [
          [" mcp__a ", "never"],
          ["MCP__A", "allow"],
        ],
        [
          ["x", "ask"],
          ["x", "ask"],
        ],
      ]
      for (const dup of dups) assert.include(yield* refused(rules(dup)), "more than one rule")
      assert.include(yield* refused(rules([["send mail", "ask"]])), "isn't a tool name")
      assert.include(yield* refused(rules([[`mcp__${"x".repeat(200)}`, "ask"]])), "isn't a tool name")
      assert.include(yield* refused({ ...rules([]), expiry_minutes: MAX_EXPIRY_MINUTES + 1 }), "a week")
      assert.include(yield* refused({ ...rules([]), expiry_minutes: -1 }), "a week")
      assert.include(yield* refused(rules(Array.from({ length: 201 }, (_, i) => [`t${i}`, "ask"] as const))), "at most 200")
    }),
  )

  it("the board's tools are ruled under any name its server went by", () => {
    const r = rules([
      ["mcp__issue_agent__create_task", "ask"],
      ["mcp__huntaway__create_task", "allow"],
    ])
    assert.deepStrictEqual(boardRule(r, "create_task"), { name: "mcp__issue_agent__create_task", rule: rule("mcp__issue_agent__create_task", "ask") })
    assert.strictEqual(boardRule(r, "delete_task"), null)
  })

  it.effect("Claude gets the hook, the prompt tool and the tools that are never", () =>
    Effect.gen(function* () {
      const r = rules([
        ["mcp__g__get*", "allow"],
        ["mcp__g__send_mail", "ask"],
        ["mcp__g__delete_mail", "never"],
        ["mcp__x", "never"],
        ["mcp__g__*trash*", "never"],
      ])
      const hook = yield* claudeHook("/opt/it's/huntaway", r)
      assert.strictEqual(hook?.matcher, "^(?:[mM][cC][pP]__[gG](?:__[\\s\\S]*)?|[mM][cC][pP]__[xX](?:__[\\s\\S]*)?)$")
      assert.strictEqual(hook?.hooks[0]?.timeout, 30)
      const command = hook?.hooks[0]?.command ?? ""
      assert.isTrue(command.startsWith("'/opt/it'\\''s/huntaway' approval-hook '"), command)
      // The command's last argument is the rules, as the hook reads them back. (Then what refuses the call if the hook
      // can't run at all.)
      const after = command.slice(command.lastIndexOf(" approval-hook ") + " approval-hook ".length)
      const [arg, fallback] = [after.slice(0, after.indexOf(" || ")), after.slice(after.indexOf(" || ") + 4)]
      assert.isTrue(fallback.endsWith("exit 2; }"), fallback)
      const unquoted = arg.slice(1, -1).replaceAll("'\\''", "'")
      assert.deepStrictEqual(parseRuleList(yield* fromJson(Schema.Unknown)(unquoted)), r.rules)
      assert.deepStrictEqual(claudeDisallowed(r), ["mcp__g__delete_mail", "mcp__x"])
      assert.isTrue(needsPromptTool(r))
      // A rule for a tool that isn't MCP's widens the matcher.
      assert.strictEqual((yield* claudeHook("/h", rules([["Bash", "ask"]])))?.matcher, "*")
      // Rules only for the board's tools need no hook (the board holds them).
      const board = rules([["mcp__huntaway__create_task", "ask"]])
      assert.strictEqual(yield* claudeHook("/h", board), null)
      assert.isTrue(!needsPromptTool(board) && claudeDisallowed(board).length === 0)
      assert.isFalse(
        needsPromptTool(
          rules([
            ["mcp__g__get*", "allow"],
            ["mcp__g__x", "never"],
          ]),
        ),
      )
      // Only allow rules: no fallback that refuses.
      assert.notInclude(yield* hookOf("/h", rules([["mcp__g__get*", "allow"]])), " || ")
      // With the gh hook, in `--settings`.
      const settings = yield* fromJson(Settings)(yield* hookSettings([ghHook("/opt/it's/huntaway"), ...(hook === null ? [] : [hook])]))
      assert.deepStrictEqual(settings.hooks.PreToolUse[0], {
        matcher: "Bash",
        hooks: [{ type: "command", command: "'/opt/it'\\''s/huntaway' gh-hook", timeout: 10 }],
      })
      assert.deepStrictEqual(settings.hooks.PreToolUse[1], hook)
    }),
  )

  // The hook runs only for the calls its matcher matches, and a call it misses goes through as though no rule matched
  // it: the matcher must match every tool a rule does, whatever its case (HA-245).
  it("the hook's matcher matches every tool a rule does, and only the servers they name", () => {
    const patterns = [
      "mcp__google",
      "mcp__Google__send_gmail_message",
      "mcp__google__*send*",
      "mcp__goo*",
      "mcp__*",
      "mcp__*__delete*",
      "mcp__g___x",
      "mcp__a.b-c(1)+[x]{2}|y^$\\z/w",
      "MCP__Work",
      " mcp__kit__x ",
      "mcp__",
      "mcp____x",
      "mcp__k*__x",
    ]
    const tools = [
      "mcp__google",
      "mcp__google__send_gmail_message",
      "mcp__GOOGLE__Send_Gmail_Message",
      "mcp__gOoGlE__list",
      "mcp__googlex__send",
      "mcp__goober__x",
      "mcp__g___x",
      "mcp__g__x",
      "mcp__a.b-c(1)+[x]{2}|y^$\\z/w__t",
      "mcp__aXb-c(1)+[x]{2}|y^$\\z/w__t",
      "mcp__work__x",
      "Mcp__WORK",
      "mcp__\u212Ait__x",
      "mcp__k\u0130t__x",
      "mcp__kit__x",
      "mcp____x",
      "mcp__",
      "mcp__other__x",
      "mcp__huntaway__create_task",
      "Bash",
      "mcp__google__line\nbreak",
    ]
    for (const pattern of patterns) {
      const matcher = claudeMatcher([{ tool: pattern, decision: "ask" }])
      assert.notStrictEqual(matcher, "*", pattern)
      // A valid regular expression either way Claude Code may build one, anchored or not.
      for (const re of [new RegExp(matcher), new RegExp(matcher, "u"), new RegExp(`^(?:${matcher})$`)]) {
        for (const tool of tools) {
          if (matches(pattern, tool)) assert.isTrue(re.test(tool), `${pattern} matches "${tool}", but ${re} doesn't`)
        }
      }
    }
    // Only the servers named: other servers' and the board's tools don't start the hook.
    const google = new RegExp(claudeMatcher(defaultRuleSet().rules.filter((r) => !r.tool.toLowerCase().startsWith("mcp__huntaway"))))
    assert.isTrue(google.test("mcp__google__send_gmail_message") && google.test("mcp__Google__x"))
    for (const tool of ["mcp__huntaway__list_tasks", "mcp__gh__pr_view", "mcp__googlex__send", "Bash"]) assert.isFalse(google.test(tool), tool)
    // Every tool for a rule that isn't an MCP server's, or one a non-ASCII letter's other cases could match.
    assert.strictEqual(
      claudeMatcher([
        { tool: "mcp__g__x", decision: "ask" },
        { tool: "Bash", decision: "never" },
      ]),
      "*",
    )
    assert.strictEqual(claudeMatcher([{ tool: "mcp__é__x", decision: "ask" }]), "*")
  })

  it.effect("inputs are summed up in a line", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* summarize({ to: "bob@example.com", subject: "Hi\nthere", cc: null, n: 3 }), "n: 3, subject: Hi there, to: bob@example.com")
      assert.strictEqual(yield* summarize({ body: "x".repeat(500) }), `body: ${"x".repeat(80)}…`)
      assert.strictEqual(yield* summarize(null), "")
      assert.strictEqual(yield* summarize([1, "a"]), '[1,"a"]')
      // A Codex prompt's: the arguments, not its question.
      assert.strictEqual(yield* summarize({ message: 'Allow the google MCP server to run tool "send"?', arguments: { to: "bob" } }), "to: bob")
    }),
  )

  it("finds the calls the hook blocked in a run's tool results", () => {
    const reason = blockedReason("mcp__google__*delete*file*")
    const message = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: reason },
          { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "exit 1" }] },
          { type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: [{ type: "text", text: `Subject: ${reason}` }] },
          { type: "tool_result", tool_use_id: "toolu_4", is_error: false, content: reason },
        ],
      },
    }
    assert.deepStrictEqual(blockedToolUses(message), ["toolu_1", "toolu_3"])
    assert.deepStrictEqual(blockedToolUses({ type: "assistant" }), [])
  })

  it.live("a hook that can't run refuses calls while rules ask or refuse", () =>
    Effect.gen(function* () {
      const out = runCommand(yield* hookOf("/nonexistent/huntaway", rules([["mcp__g__send*", "ask"]])))
      assert.strictEqual(out.status, 2)
      assert.isTrue(out.stderr.trim().endsWith(HOOK_FAILED), out.stderr)
      // Only allow rules: nothing to refuse.
      assert.notStrictEqual(runCommand(yield* hookOf("/nonexistent/huntaway", rules([["mcp__g__get*", "allow"]]))).status, 2)
    }),
  )

  // The command's fallback refuses the call when the hook can't run, and says why unless the hook refused it itself
  // (exit code 2), having said so already.
  it.live("a hook that refuses isn't explained twice", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const run = (code: number) =>
        Effect.gen(function* () {
          const exe = join(dir, `hook_${code}`)
          writeFileSync(exe, `#!/bin/sh\necho refused by the hook >&2\nexit ${code}\n`)
          chmodSync(exe, 0o755)
          const out = runCommand(yield* hookOf(exe, rules([["mcp__g__send*", "ask"]])))
          return [out.status, out.stderr.trim()]
        })
      assert.deepStrictEqual(yield* run(2), [2, "refused by the hook"])
      assert.deepStrictEqual(yield* run(1), [2, `refused by the hook\n${HOOK_FAILED}`])
      assert.deepStrictEqual(yield* run(0), [0, "refused by the hook"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("the hook's command runs the launcher's approval-hook and answers by the rules", () =>
    Effect.gen(function* () {
      const command = yield* hookOf(BIN, defaultRuleSet())
      const decision = (tool: string) =>
        Effect.gen(function* () {
          const out = runCommand(command, yield* toJson({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }))
          assert.strictEqual(out.status, 0, out.stderr)
          return out.stdout === "" ? null : (yield* fromJson(HookAnswer)(out.stdout)).hookSpecificOutput.permissionDecision
        })
      assert.strictEqual(yield* decision("mcp__google__send_gmail_message"), "ask")
      assert.strictEqual(yield* decision("mcp__google__trash_gmail_message"), "deny")
      assert.strictEqual(yield* decision("mcp__google__search_gmail_messages"), "allow")
      assert.strictEqual(yield* decision("mcp__google__create_drive_file"), null)
      // Input it can't read: refused, and said once.
      const out = runCommand(command, "not json")
      assert.deepStrictEqual([out.status, out.stderr.trim()], [2, HOOK_FAILED])
    }),
  )
})
