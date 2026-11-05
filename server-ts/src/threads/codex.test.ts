// Codex's runs as the board stores them, shaped like Claude's by agent/codex/output.ts (with agent/codex/adapter.ts's
// approvals as permission prompts), translated: the cases of agent/codex/subagent_tests.test.ts and tests.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { Run } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { handle_line } from "../agent/codex/output.ts";
import { convert, type Conversion } from "./translate.ts";
import * as store from "./store.ts";
import * as write from "./write.ts";

function running(): [Shared, Run] {
  const state = testing.state();
  // Its thread is kept as items too: `converted` checks they're a rebuild's.
  db.set_setting(state.db(), write.SETTING, "true");
  const profile = db.insert_profile(state.db(), "p", [], null);
  const task = db.insert_task(state.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "scratch",
    title: "Codex",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const run = db.insert_run(state.db(), task.id, "prompt");
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "main" } } });
  return [state, run];
}

const event = (state: Shared, run: Run, method: string, thread: string, extra: any) => handle_line(state, run, { method, params: { ...extra, threadId: thread } });

function item(state: Shared, run: Run, thread: string, it: any) {
  event(state, run, "item/started", thread, { item: it });
  event(state, run, "item/completed", thread, { item: it });
}

/** The task's messages, translated as a history that has ended (after checking its items written live are a rebuild's). */
function converted(state: Shared, run: Run): Conversion {
  const c = state.db();
  const messages = db.list_messages(c, run.task_id);
  const live = convert(messages, { finished: false });
  assert.deepEqual(write.compare(c, run.task_id), []);
  assert.deepEqual({ items: store.items(c, run.task_id), requests: store.requests(c, run.task_id) }, { items: live.items, requests: live.requests });
  return convert(messages);
}

const by_id = (c: Conversion): Record<string, any> => Object.fromEntries(c.items.map((i) => [i.id, i]));
const retained = (c: Conversion) => c.rows.filter((r) => r.disposition === "retained");

test("a_codex_turn_with_each_kind_of_item", () => {
  const [state, run] = running();
  state.add_message(run.task_id, "user", { text: "Go" });
  item(state, run, "main", { type: "reasoning", id: "r", summary: ["Thinking it over"] });
  item(state, run, "main", { type: "commandExecution", id: "sh", command: "/usr/bin/bash -lc 'ls'", cwd: "/w", status: "completed", aggregatedOutput: "a\n", exitCode: 0 });
  item(state, run, "main", { type: "commandExecution", id: "bad", command: "false", status: "failed", aggregatedOutput: "", exitCode: 1 });
  item(state, run, "main", {
    type: "fileChange",
    id: "fc",
    status: "completed",
    changes: [{ path: "/w/a.rs", kind: { type: "add" }, diff: "+x" }, { path: "/w/b.rs", kind: { type: "update", move_path: "/w/c.rs" }, diff: "@@" }],
  });
  item(state, run, "main", { type: "mcpToolCall", id: "mcp", server: "gh", tool: "pr_view", arguments: { pr: 1 }, status: "completed", result: { content: [{ type: "text", text: "PR" }] } });
  item(state, run, "main", { type: "dynamicToolCall", id: "dyn", tool: "lookup", arguments: {}, status: "completed", contentItems: [{ type: "inputText", text: "found" }] });
  item(state, run, "main", { type: "webSearch", id: "web", query: "huntaway", results: [1, 2] });
  item(state, run, "main", { type: "webSearch", id: "fetch", action: { url: "https://example.com" } });
  item(state, run, "main", { type: "imageView", id: "img", path: "/w/a.png" });
  event(state, run, "turn/plan/updated", "main", { plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "inProgress" }] });
  event(state, run, "error", "main", { willRetry: true, error: { message: "overloaded" } });
  event(state, run, "warning", "main", { message: "slow" });
  item(state, run, "main", { type: "agentMessage", id: "msg", text: "Done." });
  item(state, run, "main", { type: "contextCompaction", id: "squash" });
  event(state, run, "turn/completed", "main", { turn: { id: "t1", status: "completed", durationMs: 1500 } });
  const c = converted(state, run);
  const items = by_id(c);
  assert.deepEqual(
    c.items.map((i: any) => (i.type === "tool_call" ? `${i.kind}:${i.name}` : i.type)),
    [
      "user_message",
      "reasoning",
      "shell:Bash",
      "shell:Bash",
      "edit:ApplyPatch",
      "mcp:pr_view",
      "other:lookup",
      "web:WebSearch",
      "web:WebFetch",
      "read:Read",
      "todo:TodoWrite",
      "notice",
      "notice",
      "assistant_message",
      "compaction",
      "turn_result",
    ],
  );
  assert.deepEqual([items.sh.command, items.sh.status, items.sh.result.content], ["ls", "completed", "a\n"]);
  assert.deepEqual([items.bad.status, items.bad.result.content], ["failed", "(exit code 1)"]);
  assert.deepEqual(items.fc.changes, [
    { path: "/w/a.rs", op: "add", diff: "+x" },
    { path: "/w/b.rs", op: "update", diff: "@@", move_to: "/w/c.rs" },
  ]);
  assert.deepEqual([items.mcp.server, items.mcp.result.content], ["gh", "PR"]);
  assert.equal(items.web.query, "huntaway");
  assert.equal(items.fetch.url, "https://example.com");
  assert.equal(items.img.path, "/w/a.png");
  const plan = c.items.find((i: any) => i.kind === "todo") as any;
  assert.deepEqual(plan.todos, [{ text: "Read", status: "completed" }, { text: "Write", status: "in_progress" }]);
  assert.equal(plan.status, "completed");
  const result = c.items.at(-1) as any;
  assert.deepEqual([result.ok, result.duration_ms], [true, 1500]);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(retained(c), []);
});

test("codex_approvals_are_for_their_calls", () => {
  // agent/codex/adapter.ts's `answer` asks about an item after it has started, with an input of its own.
  const [state, run] = running();
  const ask = (id: string, tool: string, input: any, status: string) =>
    state.add_message(run.task_id, "permission", { tool_name: tool, input, tool_use_id: id, request_id: `r-${id}`, status, agent: "codex" });
  event(state, run, "item/started", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", cwd: "/w" } });
  ask("rm", "Bash", { command: "rm -rf x", cwd: "/w", description: "Clean up" }, "denied");
  event(state, run, "item/completed", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", status: "declined" } });
  const change = { type: "fileChange", id: "fc", changes: [{ path: "/w/a", kind: { type: "add" }, diff: "+" }] };
  event(state, run, "item/started", "main", { item: change });
  ask("fc", "ApplyPatch", { changes: [{ path: "/w/a", kind: "add", move_path: null, diff: "+" }], reason: "Needed" }, "allowed");
  event(state, run, "item/completed", "main", { item: { ...change, status: "completed" } });
  ask("perm", "Permissions", { permissions: { network: true }, reason: null, cwd: "/w" }, "allowed");
  const c = converted(state, run);
  const r = Object.fromEntries(c.requests.map((x) => [x.id, x as any]));
  assert.deepEqual([r["r-rm"].tool_call_id, r["r-rm"].kind, r["r-rm"].resolution.outcome], ["rm", "shell", "deny"]);
  assert.equal(by_id(c).rm.status, "denied");
  assert.deepEqual([r["r-fc"].tool_call_id, r["r-fc"].kind, r["r-fc"].title], ["fc", "edit", "/w/a"]);
  assert.equal(by_id(c).fc.status, "completed");
  // Not about a call the thread has: it names the one to come, which never did.
  assert.deepEqual([r["r-perm"].tool_call_id, r["r-perm"].kind], ["perm", "other"]);
  assert.deepEqual(c.warnings, []);
});

test("codex_subagents_keep_the_main_session_turn_and_stream_separate", () => {
  const [state, run] = running();
  for (const thread of [
    { id: "child", parentThreadId: "main", preview: "Inspect config", agentRole: "explorer" },
    { id: "nested", source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } }, preview: "Check env" },
  ]) {
    handle_line(state, run, { method: "thread/started", params: { thread } });
  }
  item(state, run, "main", {
    type: "collabAgentToolCall",
    id: "spawn",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "main",
    receiverThreadIds: ["child"],
    prompt: "Inspect config",
    model: "gpt-6.1-sol",
    agentsStates: { child: { status: "running" } },
  });
  event(state, run, "turn/started", "child", { turn: { id: "child-turn" } });
  item(state, run, "child", { type: "agentMessage", id: "text", text: "Config report" });
  item(state, run, "child", { type: "commandExecution", id: "bash", command: "ls", status: "completed", aggregatedOutput: "config.rs" });
  item(state, run, "nested", { type: "reasoning", id: "think", summary: ["Check environment"] });
  event(state, run, "turn/plan/updated", "nested", { plan: [{ step: "Read env", status: "inProgress" }] });
  event(state, run, "turn/completed", "child", { turn: { id: "child-turn", status: "completed" } });
  const c = converted(state, run);
  const items = by_id(c);
  const child = items["codex-agent-child"];
  assert.deepEqual([child.kind, child.title, child.status], ["subagent", "Inspect config", "completed"]);
  assert.deepEqual(child.subagent, { status: "completed", background: true, agent_type: "explorer", model: "gpt-6.1-sol" });
  assert.equal(items["codex-agent-nested"].parent_id, "codex-agent-child");
  assert.equal(items.bash.parent_id, "codex-agent-child");
  assert.equal(items.bash.result.content, "config.rs");
  assert.equal(c.items.find((i) => i.type === "assistant_message")!.parent_id, "codex-agent-child");
  assert.equal(c.items.find((i) => i.type === "reasoning")!.parent_id, "codex-agent-nested");
  assert.equal(c.items.find((i: any) => i.kind === "todo")!.parent_id, "codex-agent-nested");
  // The nested one never said it ended.
  assert.equal(items["codex-agent-nested"].subagent.status, "stopped");
  assert.deepEqual(c.warnings.map((w) => w.code), ["subagent_running"]);
  assert.deepEqual(retained(c), []);
});

test("codex_collab_actions_update_existing_children", () => {
  const [state, run] = running();
  const steps: Array<[number, string, string]> = [
    [1, "spawnAgent", "running"],
    [2, "wait", "completed"],
    [3, "followupTask", "running"],
    [4, "sendMessage", "running"],
    [5, "wait", "errored"],
    [6, "resumeAgent", "running"],
    [7, "closeAgent", "shutdown"],
  ];
  const states: string[] = [];
  for (const [n, tool, status] of steps) {
    item(state, run, "main", {
      type: "collabAgentToolCall",
      id: `call${n}`,
      tool,
      status: "completed",
      senderThreadId: "main",
      receiverThreadIds: ["child"],
      prompt: "Inspect config",
      model: "gpt-6.1-sol",
      agentsStates: { child: { status, message: "Child report" } },
    });
    states.push((by_id(convert(db.list_messages(state.db(), run.task_id), { finished: false }))["codex-agent-child"] as any).subagent.status);
  }
  assert.deepEqual(states, ["running", "completed", "running", "running", "failed", "running", "stopped"]);
  const c = converted(state, run);
  const items = by_id(c);
  assert.deepEqual(items["codex-agent-child"].subagent, { status: "stopped", background: true, model: "gpt-6.1-sol", summary: "Child report" });
  // The other collab calls are calls of their own.
  assert.deepEqual([items.call2.name, items.call2.kind, items.call2.status], ["wait", "other", "completed"]);
  assert.equal(c.items.filter((i: any) => i.kind === "subagent").length, 1);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(retained(c), []);
});

test("codex_hosted_activity_and_late_metadata_share_one_row", () => {
  const [state, run] = running();
  item(state, run, "main", { type: "subAgentActivity", id: "hosted1", kind: "started", agentThreadId: "hosted", model: "gpt-6.1-sol" });
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "hosted", parentThreadId: "main", preview: "Find tests" } } });
  item(state, run, "hosted", { type: "subAgentActivity", id: "hosted2", kind: "started", agentThreadId: "nested" });
  item(state, run, "main", { type: "subAgentActivity", id: "hosted3", kind: "completed", agentThreadId: "hosted" });
  item(state, run, "hosted", { type: "subAgentActivity", id: "hosted4", kind: "interrupted", agentThreadId: "nested" });
  const c = converted(state, run);
  const items = by_id(c);
  assert.deepEqual(items["codex-agent-hosted"].subagent, { status: "completed", background: true, model: "gpt-6.1-sol" });
  assert.deepEqual([items["codex-agent-nested"].parent_id, items["codex-agent-nested"].subagent.status], ["codex-agent-hosted", "stopped"]);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(retained(c), []);
});

test("codex_failed_spawns_and_child_failures", () => {
  const [state, run] = running();
  item(state, run, "main", {
    type: "collabAgentToolCall",
    id: "bad-spawn",
    tool: "spawnAgent",
    status: "failed",
    receiverThreadIds: [],
    agentsStates: { missing: { status: "notFound", message: "No agent available" } },
  });
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "review", source: { subAgent: "review" } } } });
  event(state, run, "turn/completed", "child", { turn: { id: "child-turn", status: "failed", error: { message: "Child failed" } } });
  event(state, run, "turn/completed", "main", { turn: { id: "main-turn", status: "completed" } });
  const c = converted(state, run);
  const items = by_id(c);
  assert.deepEqual([items["bad-spawn"].name, items["bad-spawn"].status], ["spawnAgent", "failed"]);
  assert.equal(items["bad-spawn"].subagent, undefined);
  assert.equal(c.items.at(-1)!.type, "turn_result");
  // The board tells of children that never started: those messages stay in the source only.
  assert.deepEqual(c.warnings.map((w) => w.code), ["unknown_task", "unknown_task"]);
  assert.equal(retained(c).length, 2);
});
