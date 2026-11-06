// Port of server/src/agent/approval_rules/tests.rs and server/tests/approval_hook.rs (HA-123, on the HA-117 branch).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import * as testing from "../../testing.ts";
import * as assistant from "../assistant.ts";
import * as google from "../assistant/google.ts";
import * as codex from "../codex.ts";
import * as runner from "../runner.ts";
import * as permissions from "../../mcp/permissions.ts";
import {
  BLOCKED, BOARD_SERVER_NAMES, HOOK_FAILED, MAX_EXPIRY_MINUTES, Rules_default, applies_to, blocked_reason, checked, claude_disallowed, claude_hook, claude_matcher,
  codex_needs_user_reviewer, codex_own_tools, codex_policy, codex_server, decide, default_rules, for_mode, for_task, get, hook_decision, list,
  matches, needs_prompt_tool, on_tool_results, parse_rule_list, set, summarize,
} from "../approval_rules.ts";
import type { Decision, Rule, Rules } from "../approval_rules.ts";

const rule = (tool: string, decision: Decision): Rule => ({ tool, decision });

function rules(list: Array<[string, Decision]>): Rules {
  return { rules: list.map(([t, d]) => rule(t, d)), expiry_minutes: 30 };
}

function decided(r: Rules, tool: string): Decision | null {
  return decide(r, tool)?.decision ?? null;
}

test("the_hooks_mirrored_constants_match_their_modules", () => {
  assert.deepEqual([...BOARD_SERVER_NAMES], [runner.MCP_SERVER_NAME, runner.LEGACY_MCP_SERVER_NAME, "issue-agent"]);
  const all = rules([["*", "never"]]);
  for (const t of [permissions.ASK_USER, permissions.CODEX_QUESTIONS, permissions.EXIT_PLAN]) assert.equal(decided(all, t), null, t);
});

test("a_rule_names_a_tool_a_server_or_a_pattern", () => {
  assert.ok(matches("Bash", "Bash"));
  assert.ok(!matches("Bash", "BashOutput"));
  assert.ok(matches("mcp__google__send_gmail_message", "mcp__google__send_gmail_message"));
  // A server's prefix is all its tools, and only its.
  assert.ok(matches("mcp__google", "mcp__google__send_gmail_message"));
  assert.ok(!matches("mcp__google", "mcp__googlemaps__search"));
  assert.ok(!matches("mcp__google__send", "mcp__google__send_gmail_message"));
  // Patterns, without regard to case.
  assert.ok(matches("mcp__google__*delete*", "mcp__google__delete_event"));
  assert.ok(matches("mcp__google__*Delete*", "mcp__google__gmail_deleteMessage"));
  assert.ok(matches("mcp__*__send*", "mcp__mail__send_now"));
  assert.ok(!matches("mcp__google__*delete*", "mcp__other__delete_event"));
  assert.ok(matches("*", "anything"));
  assert.ok(!matches("", "anything"));
  assert.ok(!matches("a*b", "acbd"));
  assert.ok(matches("a*b*", "acbd"));
});

test("the_strongest_matching_rule_decides", () => {
  const r = rules([["mcp__google", "allow"], ["mcp__google__*send*", "ask"], ["mcp__google__*delete*", "never"]]);
  assert.equal(decided(r, "mcp__google__search"), "allow");
  assert.equal(decided(r, "mcp__google__send_mail"), "ask");
  assert.equal(decided(r, "mcp__google__send_then_delete"), "never");
  assert.equal(decided(r, "Bash"), null);
  // Questions and plans are the user's whatever the rules.
  const all = rules([["*", "never"]]);
  assert.equal(decided(all, "AskUserQuestion"), null);
  assert.equal(decided(all, "ExitPlanMode"), null);
  assert.equal(decided(all, "request_user_input"), null);
});

test("the_google_defaults_read_and_draft_ask_to_send_and_never_delete", () => {
  const r = Rules_default();
  const g = (t: string) => decided(r, `mcp__google__${t}`);
  for (const t of [
    "search_gmail_messages", "get_gmail_message_content", "list_calendars", "get_events", "search_drive_files", "get_drive_file_content", "draft_gmail_message",
    "list_drive_items", "get_drive_file_permissions",
  ]) {
    assert.equal(g(t), "allow", t);
  }
  for (const t of [
    "send_gmail_message", "create_event", "modify_event", "delete_event", "share_drive_file", "modify_gmail_message_labels", "batch_modify_gmail_message_labels",
    "update_drive_permission", "manage_event", "update_drive_file", "create_gmail_filter", "transfer_drive_ownership", "manage_gmail_label",
  ]) {
    assert.equal(g(t), "ask", t);
  }
  for (const t of ["delete_gmail_message", "trash_gmail_message", "delete_drive_file", "trash_drive_file", "gmail_deleteMessage"]) assert.equal(g(t), "never", t);
  // Another server's tools, and the board's, are left to the thread's mode.
  assert.equal(decided(r, "mcp__other__send_gmail_message"), null);
  assert.equal(decided(r, "mcp__huntaway__create_task"), null);
  assert.equal(r.expiry_minutes, 30);
});

/**
 * workspace-mcp 2.3.0's Gmail, Calendar and Drive tools at its `extended` tier, as the assistant's Google server serves
 * them (assistant/google.ts, HA-210): reading and drafting are allowed, sending, sharing and changing ask, and making a
 * file or a calendar is left to the thread's mode. A new version of the server is checked against this.
 */
test("the_google_defaults_fit_the_google_servers_own_tools", () => {
  const r = Rules_default();
  const g = (t: string) => decided(r, `mcp__${google.SERVER}__${t}`);
  const allow = [
    "search_gmail_messages", "get_gmail_message_content", "get_gmail_messages_content_batch", "get_gmail_attachment_content", "get_gmail_thread_content",
    "list_gmail_labels", "draft_gmail_message", "list_gmail_filters", "list_calendars", "get_events", "query_freebusy", "search_drive_files",
    "get_drive_file_content", "get_drive_file_download_url", "list_drive_items",
  ];
  for (const t of allow) assert.equal(g(t), "allow", t);
  const ask = [
    "send_gmail_message", "modify_gmail_message_labels", "manage_gmail_label", "manage_gmail_filter", "manage_event", "manage_out_of_office",
    "manage_focus_time", "update_drive_file", "manage_drive_access", "set_drive_file_permissions",
    // It reads a link, but may make the file shareable to give one.
    "get_drive_shareable_link",
  ];
  for (const t of ask) assert.equal(g(t), "ask", t);
  for (const t of ["create_drive_file", "create_drive_folder", "copy_drive_file", "import_to_google_doc", "create_calendar"]) assert.equal(g(t), null, t);
});

test("rules_are_tidied_and_checked_for_saving", () => {
  const r = checked(rules([[" mcp__a ", "allow"], ["", "ask"], ["mcp__b", "ask"]]));
  assert.deepEqual(r.rules, [rule("mcp__a", "allow"), rule("mcp__b", "ask")]);
  // A pattern twice is refused, whatever its case or decisions, rather than one of them dropped.
  const dups: Array<Array<[string, Decision]>> = [[["Bash", "allow"], ["Bash", "never"]], [[" mcp__a ", "never"], ["MCP__A", "allow"]], [["x", "ask"], ["x", "ask"]]];
  for (const dup of dups) assert.throws(() => checked(rules(dup)), /more than one rule/);
  assert.throws(() => checked(rules([["send mail", "ask"]])));
  assert.throws(() => checked({ ...rules([]), expiry_minutes: MAX_EXPIRY_MINUTES + 1 }));
  const many: Array<[string, Decision]> = Array.from({ length: 201 }, (_, i) => [`t${i}`, "ask"]);
  assert.throws(() => checked(rules(many)));
});

test("plan_mode_takes_no_allow_rules", () => {
  const r = rules([["mcp__g__get*", "allow"], ["mcp__g__send*", "ask"], ["mcp__g__del*", "never"]]);
  assert.equal(decided(for_mode(r, "plan"), "mcp__g__get_mail"), null);
  assert.equal(decided(for_mode(r, "plan"), "mcp__g__send_mail"), "ask");
  assert.equal(decided(for_mode(r, "default"), "mcp__g__get_mail"), "allow");
});

function call(tool: string): any {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { to: "bob@example.com" } };
}

test("the_hook_allows_asks_or_blocks_by_the_rules", () => {
  const r = rules([["mcp__g__get*", "allow"], ["mcp__g__send*", "ask"], ["mcp__g__del*", "never"], ["mcp__huntaway__create_task", "ask"]]);
  const out = (tool: string) => hook_decision(r, call(tool))?.hookSpecificOutput.permissionDecision ?? null;
  assert.equal(out("mcp__g__get_mail"), "allow");
  assert.equal(out("mcp__g__send_mail"), "ask");
  assert.equal(out("mcp__g__delete_mail"), "deny");
  // Nothing to say about the rest, nor about the board's tools, which the board decides itself.
  assert.equal(out("mcp__g__other"), null);
  assert.equal(out("mcp__huntaway__create_task"), null);
  const deny = hook_decision(r, call("mcp__g__delete_mail"));
  const reason: string = deny.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith(`${BLOCKED} (never: mcp__g__del*)`), reason);
  assert.equal(deny.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("claude_gets_the_hook_the_prompt_tool_and_the_tools_that_are_never", () => {
  const r = rules([["mcp__g__get*", "allow"], ["mcp__g__send_mail", "ask"], ["mcp__g__delete_mail", "never"], ["mcp__x", "never"], ["mcp__g__*trash*", "never"]]);
  const hook = claude_hook("/opt/it's/huntaway", r);
  assert.equal(hook.matcher, "^(?:[mM][cC][pP]__[gG](?:__[\\s\\S]*)?|[mM][cC][pP]__[xX](?:__[\\s\\S]*)?)$");
  const command: string = hook.hooks[0].command;
  assert.ok(command.startsWith("'/opt/it'\\''s/huntaway' approval-hook '"), command);
  // The command's last argument is the rules, as the hook reads them back. (Then what refuses the call if the hook
  // can't run at all.)
  const after = command.slice(command.lastIndexOf(" approval-hook ") + " approval-hook ".length);
  const [arg, fallback] = [after.slice(0, after.indexOf(" || ")), after.slice(after.indexOf(" || ") + 4)];
  assert.ok(fallback.endsWith("exit 2; }"), fallback);
  const unquoted = arg.slice(1, -1).replaceAll("'\\''", "'");
  assert.deepEqual(parse_rule_list(JSON.parse(unquoted)), r.rules);
  assert.deepEqual(claude_disallowed(r), ["mcp__g__delete_mail", "mcp__x"]);
  assert.ok(needs_prompt_tool(r));
  // A rule for a tool that isn't MCP's widens the matcher.
  assert.equal(claude_hook("/h", rules([["Bash", "ask"]])).matcher, "*");
  // Rules only for the board's tools need no hook (the board holds them).
  const board = rules([["mcp__huntaway__create_task", "ask"]]);
  assert.equal(claude_hook("/h", board), null);
  assert.ok(!needs_prompt_tool(board) && claude_disallowed(board).length === 0);
  assert.ok(!needs_prompt_tool(rules([["mcp__g__get*", "allow"], ["mcp__g__x", "never"]])));
});

// The hook runs only for the calls its matcher matches, and a call it misses goes through as though no rule matched it:
// the matcher must match every tool a rule does, whatever its case (HA-245).
test("the_hooks_matcher_matches_every_tool_a_rule_does_and_only_the_servers_they_name", () => {
  const patterns = [
    "mcp__google", "mcp__Google__send_gmail_message", "mcp__google__*send*", "mcp__goo*", "mcp__*", "mcp__*__delete*", "mcp__g___x",
    "mcp__a.b-c(1)+[x]{2}|y^$\\z/w", "MCP__Work", " mcp__kit__x ", "mcp__", "mcp____x", "mcp__k*__x",
  ];
  const tools = [
    "mcp__google", "mcp__google__send_gmail_message", "mcp__GOOGLE__Send_Gmail_Message", "mcp__gOoGlE__list", "mcp__googlex__send",
    "mcp__goober__x", "mcp__g___x", "mcp__g__x", "mcp__a.b-c(1)+[x]{2}|y^$\\z/w__t", "mcp__aXb-c(1)+[x]{2}|y^$\\z/w__t", "mcp__work__x",
    "Mcp__WORK", "mcp__\u212Ait__x", "mcp__k\u0130t__x", "mcp__kit__x", "mcp____x", "mcp__", "mcp__other__x", "mcp__huntaway__create_task",
    "Bash", "mcp__google__line\nbreak",
  ];
  for (const pattern of patterns) {
    const matcher = claude_matcher([{ tool: pattern, decision: "ask" }]);
    assert.notEqual(matcher, "*", pattern);
    // A valid regular expression either way Claude Code may build one, anchored or not.
    for (const re of [new RegExp(matcher), new RegExp(matcher, "u"), new RegExp(`^(?:${matcher})$`)]) {
      for (const tool of tools) {
        if (matches(pattern, tool)) assert.ok(re.test(tool), `${pattern} matches ${JSON.stringify(tool)}, but ${re} doesn't`);
      }
    }
  }
  // Only the servers named: other servers' and the board's tools don't start the hook.
  const google = new RegExp(claude_matcher(Rules_default().rules.filter((r) => !r.tool.toLowerCase().startsWith("mcp__huntaway"))));
  assert.ok(google.test("mcp__google__send_gmail_message") && google.test("mcp__Google__x"));
  for (const tool of ["mcp__huntaway__list_tasks", "mcp__gh__pr_view", "mcp__googlex__send", "Bash"]) assert.ok(!google.test(tool), tool);
  // Every tool for a rule that isn't an MCP server's, or one a non-ASCII letter's other cases could match.
  assert.equal(claude_matcher([{ tool: "mcp__g__x", decision: "ask" }, { tool: "Bash", decision: "never" }]), "*");
  assert.equal(claude_matcher([{ tool: "mcp__é__x", decision: "ask" }]), "*");
});

test("codex_asks_about_every_call_of_a_server_a_rule_may_match", () => {
  const r = rules([["mcp__g__get*", "allow"], ["mcp__g__read_mail", "allow"], ["mcp__g__send_mail", "ask"], ["mcp__g__delete_mail", "never"], ["mcp__off", "never"]]);
  const g: any = { command: "g", default_tools_approval_mode: "approve", disabled_tools: ["x"] };
  assert.ok(codex_server(r, "g", g));
  assert.equal(g.default_tools_approval_mode, "prompt");
  assert.deepEqual(g.tools, { read_mail: { approval_mode: "approve" }, send_mail: { approval_mode: "prompt" } });
  assert.deepEqual(g.disabled_tools, ["x", "delete_mail"]);
  // A server a never rule names is left out.
  assert.ok(!codex_server(r, "off", {}));
  // One no rule may match is as it was.
  const other: any = { command: "o" };
  assert.ok(codex_server(r, "other", other));
  assert.deepEqual(other, { command: "o" });
  // A pattern may match any server's tools.
  const any: any = {};
  assert.ok(codex_server(rules([["*delete*", "never"]]), "other", any));
  assert.equal(any.default_tools_approval_mode, "prompt");
  // Only allow rules: nothing asks that didn't before.
  const allowed: any = {};
  assert.ok(codex_server(rules([["mcp__g__get_mail", "allow"], ["mcp__g__list*", "allow"]]), "g", allowed));
  assert.deepEqual(allowed, { tools: { get_mail: { approval_mode: "approve" } } });
  // An exact allow that a stronger pattern overrules isn't approved up front.
  const overruled: any = {};
  assert.ok(codex_server(rules([["mcp__g__delete_draft", "allow"], ["mcp__g__*delete*", "never"]]), "g", overruled));
  assert.deepEqual(overruled.tools, {});
  // The board's own server is the board's to hold.
  const board: any = {};
  assert.ok(codex_server(rules([["*", "never"]]), "huntaway", board));
  assert.deepEqual(board, {});
  assert.ok(codex_needs_user_reviewer(r) && !codex_needs_user_reviewer(rules([["mcp__g__get*", "allow"]])));
});

test("inputs_are_summed_up_in_a_line", () => {
  assert.equal(summarize({ to: "bob@example.com", subject: "Hi\nthere", cc: null, n: 3 }), "n: 3, subject: Hi there, to: bob@example.com");
  assert.equal(summarize({ body: "x".repeat(500) }), `body: ${"x".repeat(80)}…`);
  assert.equal(summarize(null), "");
  // A Codex prompt's: the arguments, not its question.
  assert.equal(summarize({ message: 'Allow the google MCP server to run tool "send"?', arguments: { to: "bob" } }), "to: bob");
});

function new_task(s: ReturnType<typeof testing.state>, profile_id: string, parent: string | null): Task {
  const t = db.insert_task(s.db(), {
    profile_id, project_id: null, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: null, effort: null,
    claude_config_id: null,
  });
  return parent !== null ? db.update_task(s.db(), t.id, [["parent_id", parent]])! : t;
}

test("rules_hold_for_the_assistant_and_threads_under_it", () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "me", [], null);
  const the_assistant = assistant.get_or_create(s, profile.id);
  const [child, other] = [new_task(s, profile.id, the_assistant.id), new_task(s, profile.id, null)];
  assert.deepEqual(for_task(s.db(), the_assistant), Rules_default());
  assert.ok(applies_to(s.db(), child));
  assert.equal(for_task(s.db(), other), null);
  // Saved, they're the profile's; reset, the defaults again.
  const mine = rules([["mcp__g", "ask"]]);
  set(s.db(), profile.id, mine);
  assert.deepEqual(for_task(s.db(), child), mine);
  set(s.db(), profile.id, null);
  assert.deepEqual(get(s.db(), profile.id), Rules_default());
});

test("calls_the_hook_blocked_go_in_the_action_log", () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "me", [], null);
  const task = assistant.get_or_create(s, profile.id);
  const use = (id: string, name: string, input: any) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  s.add_message(task.id, "claude", use("toolu_1", "mcp__google__delete_drive_file", { file_id: "f1" }));
  const reason = blocked_reason("mcp__google__*delete*file*");
  const result = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: reason },
        // Another tool's failure isn't a block.
        { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "exit 1" }] },
      ],
    },
  };
  on_tool_results(s, task, result);
  // Not another tool's output that quotes the reason (mail about the rules, say), nor a board tool's refusal, which the
  // board logs itself.
  for (const [id, name] of [["toolu_3", "mcp__google__search_gmail_messages"], ["toolu_4", "mcp__huntaway__delete_task"]]) {
    s.add_message(task.id, "claude", use(id, name, {}));
  }
  set(s.db(), profile.id, { rules: [...default_rules(), rule("mcp__huntaway__delete_task", "never")], expiry_minutes: 30 });
  const quoted = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: `Subject: ${reason}` },
        { type: "tool_result", tool_use_id: "toolu_4", is_error: true, content: blocked_reason("mcp__huntaway__delete_task") },
      ],
    },
  };
  on_tool_results(s, task, quoted);
  const log = list(s.db(), profile.id, 10);
  assert.equal(log.length, 1);
  const a = log[0];
  assert.deepEqual(
    [a.tool_name, a.summary, a.rule, a.decision, a.outcome, a.answered_by],
    ["mcp__google__delete_drive_file", "file_id: f1", "mcp__google__*delete*file*", "never", "blocked", "rule"],
  );
});

test("codex_asks_about_its_own_tools_for_an_ask_rule_and_wont_run_with_a_never_rule", () => {
  assert.equal(codex_own_tools(Rules_default()), false);
  assert.equal(codex_own_tools(rules([["mcp__g__x", "never"], ["Bash", "ask"]])), true);
  assert.equal(codex_own_tools(rules([["Bash", "allow"]])), false);
  for (const never of ["Bash", "*", "ApplyPatch"]) {
    assert.throws(
      () => codex_own_tools(rules([[never, "never"]])),
      (e: any) => e.message.includes(`"${never}: never"`) && e.message.includes("Claude config"),
    );
  }
});

test("codex_runs_with_rules_on_its_own_tools_ask_whatever_their_mode", () => {
  const policy = (r: Rules | null, mode: string) => codex_policy(r, codex.policy(mode, false));
  // No rules: as the mode has it.
  assert.deepEqual(policy(null, "bypassPermissions"), ["never", "user", "danger-full-access"]);
  assert.deepEqual(policy(null, "auto"), ["on-request", "auto_review", "workspace-write"]);
  // Rules for MCP tools only: the user answers rather than Codex's reviewer, the policy stays.
  const mcp = rules([["mcp__g__send*", "ask"]]);
  assert.deepEqual(policy(mcp, "auto"), ["on-request", "user", "workspace-write"]);
  assert.deepEqual(policy(mcp, "bypassPermissions"), ["never", "user", "danger-full-access"]);
  // An ask rule on Bash: Codex asks about every command it doesn't take as safe, in Bypass too, and without full
  // access; in plan mode its sandbox stays read-only.
  const bash = rules([["Bash", "ask"]]);
  for (const mode of ["bypassPermissions", "dontAsk", "auto", "acceptEdits", "default"]) {
    assert.deepEqual(policy(bash, mode), ["untrusted", "user", "workspace-write"], mode);
  }
  assert.deepEqual(policy(bash, "plan"), ["untrusted", "user", "read-only"]);
  // Never on Bash: it doesn't run.
  assert.throws(() => policy(rules([["Bash", "never"]]), "default"));
});

test("a_hook_that_cant_run_refuses_calls_while_rules_ask_or_refuse", () => {
  const run = (r: Rules) => {
    const command: string = claude_hook("/nonexistent/huntaway", r).hooks[0].command;
    return spawnSync("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  };
  const out = run(rules([["mcp__g__send*", "ask"]]));
  assert.equal(out.status, 2);
  assert.ok(out.stderr.trim().endsWith(HOOK_FAILED), out.stderr);
  // Only allow rules: nothing to refuse.
  assert.notEqual(run(rules([["mcp__g__get*", "allow"]])).status, 2);
});

// ---------- `huntaway approval-hook`, through bin/huntaway (server/tests/approval_hook.rs) ----------

const BIN = fileURLToPath(new URL("../../../bin/huntaway", import.meta.url));

function hook(rules: string, input: string) {
  return spawnSync(BIN, ["approval-hook", rules], { input, encoding: "utf8" });
}

function hook_out(out: { stdout: string }): string | null {
  try {
    return JSON.parse(out.stdout).hookSpecificOutput.permissionDecision ?? null;
  } catch {
    return null;
  }
}

const STRICT = '[{"tool": "mcp__google__*send*", "decision": "ask"}, {"tool": "mcp__google__*delete*", "decision": "never"}]';

const hook_call = (tool: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} });

test("the_hook_decides_by_the_rules", () => {
  for (const [tool, want] of [["mcp__google__send_mail", "ask"], ["mcp__google__delete_mail", "deny"], ["mcp__google__get_mail", null]] as const) {
    const out = hook(STRICT, hook_call(tool));
    assert.equal(out.status, 0, `${tool}: ${out.stderr}`);
    assert.equal(hook_out(out), want, tool);
  }
});

test("the_hook_refuses_what_it_cant_check_while_rules_ask_or_refuse", () => {
  // Input it can't read, rules it can't read: refused, which exit code 2 is for a PreToolUse hook.
  const cases: Array<[string, string]> = [[STRICT, "not json"], [STRICT, "{}"], ["not rules", hook_call("mcp__google__get_mail")], [STRICT, ""]];
  for (const [rules, input] of cases) {
    const out = hook(rules, input);
    assert.equal(out.status, 2, `${rules} ${input}`);
    assert.ok(out.stderr.includes("couldn't be checked"), out.stderr);
  }
  // No rules argument at all, or rules of the wrong shape: refused too.
  for (const args of [["approval-hook"], ["approval-hook", '[{"tool": "x"}]'], ["approval-hook", '{"rules": []}']]) {
    const out = spawnSync(BIN, args, { input: hook_call("mcp__google__get_mail"), encoding: "utf8" });
    assert.equal(out.status, 2, args.join(" "));
  }
  // With only allow rules, the call is left to the run's own permissions.
  const out = hook('[{"tool": "mcp__google__get*", "decision": "allow"}]', "not json");
  assert.deepEqual([out.status, hook_out(out)], [0, null]);
});

// Node before 24.2 doesn't set import.meta.main, and engines allows Node 24.0: there, a hook that ran only `if
// (import.meta.main)` exited 0 with no output, which Claude Code takes as no decision, so ask and never rules didn't
// hold (HA-245). bin/huntaway's node here is one whose modules see import.meta.main as undefined, as they do there.
function old_node(): Record<string, string> {
  const dir = testing.temp_dir();
  const preload = join(dir, "no_main.mjs");
  writeFileSync(
    preload,
    `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.startsWith("file:") && r.source != null) r.source = String(r.source).replaceAll("import.meta.main", "undefined");
    return r;
  },
});
`,
  );
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(pathToFileURL(preload).href)} "$@"\n`);
  chmodSync(node, 0o755);
  // It does take import.meta.main away.
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, "if (import.meta.main) process.exit(3);\n");
  assert.equal(spawnSync(node, [probe]).status, 0);
  assert.equal(spawnSync(process.execPath, [probe]).status, 3);
  return { ...process.env, IA_NODE: node } as Record<string, string>;
}

test("the_hook_runs_without_import_meta_main", () => {
  const env = old_node();
  const run = (args: string[], input: string) => spawnSync(BIN, args, { input, encoding: "utf8", env });
  for (const [rules, input] of [[STRICT, "not json"], [STRICT, "{}"], ["not rules", hook_call("mcp__google__get_mail")]]) {
    const out = run(["approval-hook", rules], input);
    assert.equal(out.status, 2, `${rules} ${input}: ${out.stderr}`);
    assert.ok(out.stderr.includes("couldn't be checked"), out.stderr);
  }
  const out = run(["approval-hook", STRICT], hook_call("mcp__google__delete_mail"));
  assert.deepEqual([out.status, hook_out(out)], [0, "deny"], out.stderr);
  // The agents' MCP helper starts too: here, to say it has no board to talk to, rather than exiting 0 with nothing said.
  const env_without = { ...env };
  for (const k of ["IA_URL", "IA_TOKEN", "IA_RUN_ID"]) delete env_without[k];
  const mcp = spawnSync(BIN, ["mcp"], { input: "", encoding: "utf8", env: env_without });
  assert.deepEqual([mcp.status, mcp.stderr.trim()], [1, "Error: IA_URL not set"]);
});

// ---------- hook_main.ts when hook.ts can't be loaded, and `huntaway approval-hook` through main.ts (HA-254) ----------

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** node's arguments for a preload that makes approval_rules/hook.ts fail to load, as a broken install would. */
function broken_hook_ts(): string[] {
  const preload = join(testing.temp_dir(), "broken_hook.mjs");
  writeFileSync(
    preload,
    `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/agent/approval_rules/hook.ts")) r.source = 'throw new Error("hook.ts is broken");';
    return r;
  },
});
`,
  );
  return ["--import", pathToFileURL(preload).href];
}

const node_run = (args: string[], input: string) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { input, encoding: "utf8" });

test("hook_main_refuses_calls_with_hook_faileds_message_when_hook_ts_cant_be_loaded", () => {
  const broken = broken_hook_ts();
  for (const entry of [[join(SRC, "agent/approval_rules/hook_main.ts")], [join(SRC, "main.ts"), "approval-hook"]]) {
    const out = node_run([...broken, ...entry, STRICT], hook_call("mcp__google__get_mail"));
    assert.equal(out.status, 2, `${entry.join(" ")}: ${out.stderr}`);
    // hook_main.ts's FALLBACK, a hand-kept copy of HOOK_FAILED (hook.ts isn't loaded before its handlers are on): the
    // same but for saying the hook failed to start.
    assert.equal(out.stderr.trim().replace("(their hook failed to start)", "(their hook failed)"), HOOK_FAILED, entry.join(" "));
  }
});

// A server not started through bin/huntaway runs the hook through main.ts: whatever fails refuses the call with exit
// code 2, as from hook_main.ts, rather than 1, which lets it through.
test("the_hook_through_main_ts_decides_and_refuses_as_through_bin_huntaway", () => {
  const main = (args: string[], input: string) => node_run([join(SRC, "main.ts"), "approval-hook", ...args], input);
  for (const [tool, want] of [["mcp__google__send_mail", "ask"], ["mcp__google__delete_mail", "deny"], ["mcp__google__get_mail", null]] as const) {
    const out = main([STRICT], hook_call(tool));
    assert.deepEqual([out.status, hook_out(out)], [0, want], `${tool}: ${out.stderr}`);
  }
  for (const [args, input] of [[[STRICT], "not json"], [[STRICT], "{}"], [["not rules"], hook_call("mcp__google__get_mail")], [[], hook_call("x")]] as const) {
    const out = main([...args], input);
    assert.equal(out.status, 2, `${args.join(" ")} ${input}`);
    assert.equal(out.stderr.trim(), HOOK_FAILED);
  }
});

// The command's fallback refuses the call when the hook can't run, and says why unless the hook refused it itself (exit
// code 2), having said so already.
test("a_hook_that_refuses_isnt_explained_twice", () => {
  const dir = testing.temp_dir();
  const run = (code: number) => {
    const exe = join(dir, `hook_${code}`);
    writeFileSync(exe, `#!/bin/sh\necho refused by the hook >&2\nexit ${code}\n`);
    chmodSync(exe, 0o755);
    const command: string = claude_hook(exe, rules([["mcp__g__send*", "ask"]])).hooks[0].command;
    const out = spawnSync("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return [out.status, out.stderr.trim()];
  };
  assert.deepEqual(run(2), [2, "refused by the hook"]);
  assert.deepEqual(run(1), [2, `refused by the hook\n${HOOK_FAILED}`]);
  assert.deepEqual(run(0), [0, "refused by the hook"]);
});
