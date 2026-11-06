// Port of server/src/agent/codex/subagent_tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { handle_line } from "./output.ts";

function running(): [Shared, Run] {
  const state = testing.state();
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

function event(state: Shared, run: Run, method: string, thread: string, extra: any) {
  const params = { ...extra, threadId: thread };
  handle_line(state, run, { method, params });
}

function item(state: Shared, run: Run, thread: string, it: any) {
  event(state, run, "item/started", thread, { item: it });
  event(state, run, "item/completed", thread, { item: it });
}

function messages(state: Shared, run: Run): any[] {
  return testing
    .messages(state.db(), run.task_id)
    .filter((m) => m.kind === "claude")
    .map((m) => m.data);
}

function calls(state: Shared, run: Run): any[] {
  return messages(state, run).filter((m) => m.type === "assistant" && m.message?.content?.[0]?.type === "tool_use");
}

const session = (state: Shared, run: Run) => db.get_task(state.db(), run.task_id)!.session_id;
const saw_result = (state: Shared, run: Run) => db.get_run(state.db(), run.id)!.saw_result;

test("codex_subagents_keep_the_main_session_turn_and_stream_separate", () => {
  const [state, run] = running();
  const emitted: any[] = [];
  state.events.subscribe((v) => emitted.push(v));
  // Both parentThreadId and v2's source.subAgent identify the parent before spawn returns.
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
  // A child starting, streaming or compacting mustn't reset the main preview.
  event(state, run, "turn/started", "child", { turn: { id: "child-turn" } });
  event(state, run, "item/agentMessage/delta", "main", { delta: "Main preview" });
  event(state, run, "item/agentMessage/delta", "child", { delta: "Child preview" });
  item(state, run, "child", { type: "agentMessage", id: "text", text: "Config report" });
  item(state, run, "child", { type: "commandExecution", id: "bash", command: "ls", status: "completed", aggregatedOutput: "config.rs" });
  item(state, run, "nested", { type: "reasoning", id: "think", summary: ["Check environment"] });
  event(state, run, "turn/plan/updated", "nested", { plan: [{ step: "Read env", status: "inProgress" }] });
  event(state, run, "turn/completed", "child", { turn: { id: "child-turn", status: "completed" } });
  assert.equal(session(state, run), "main");
  const r = db.get_run(state.db(), run.id)!;
  assert.ok(!r.saw_result && r.result_error === null, "a child's completion isn't the run's result");
  const deltas = emitted.filter((v) => v.type === "delta" || v.type === "delta_reset");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].text, "Main preview");
  const all = messages(state, run);
  assert.ok(all.some((m) => m.parent_tool_use_id === "codex-agent-child" && m.message?.content?.[0]?.text === "Config report"));
  assert.ok(all.some((m) => m.parent_tool_use_id === "codex-agent-child" && m.message?.content?.[0]?.content === "config.rs"));
  assert.ok(all.some((m) => m.parent_tool_use_id === "codex-agent-nested" && m.message?.content?.[0]?.thinking === "Check environment"));
  const agents = calls(state, run).filter((m) => m.message.content[0].name === "Agent");
  assert.equal(agents.length, 2);
  assert.equal(agents[1].parent_tool_use_id, "codex-agent-child");
  assert.equal(agents[0].message.content[0].input.run_in_background, true);
});

test("codex_source_only_children_accept_v2_and_legacy_spelling", () => {
  for (const spelling of ["subAgent", "subagent"]) {
    const [state, run] = running();
    const thread = { id: "child", source: { [spelling]: { thread_spawn: { parent_thread_id: "main", agent_role: "explorer" } } }, preview: "Inspect config" };
    handle_line(state, run, { method: "thread/started", params: { thread } });
    assert.equal(session(state, run), "main");
    const c = calls(state, run);
    assert.equal(c.length, 1);
    assert.equal(c[0].message.content[0].input.subagent_type, "explorer");
    assert.equal(c[0].parent_tool_use_id, null);
    for (const kind of ["review", "compact"]) {
      const thread = { id: kind, source: { [spelling]: kind } };
      handle_line(state, run, { method: "thread/started", params: { thread } });
      event(state, run, "turn/completed", kind, { turn: { id: kind, status: "completed" } });
      assert.equal(session(state, run), "main");
      assert.ok(!saw_result(state, run));
    }
  }
});

test("codex_collab_actions_update_existing_children_instead_of_spawning_rows", () => {
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
  }
  const c = calls(state, run);
  assert.equal(c.length, 7);
  assert.equal(c.filter((m) => m.message.content[0].name === "Agent").length, 1);
  const all = messages(state, run);
  const statuses = all.filter((m) => m.subtype === "task_notification").map((m) => m.status);
  assert.deepEqual(statuses, ["completed", "failed", "stopped", "stopped"]);
  assert.ok(all.some((m) => m.subtype === "task_updated" && m.patch?.status === "running"));
  assert.ok(all.filter((m) => m.subtype === "task_notification").every((m) => m.tool_use_id === "codex-agent-child"));
});

test("codex_hosted_activity_and_late_metadata_share_one_row", () => {
  const [state, run] = running();
  item(state, run, "main", { type: "subAgentActivity", id: "hosted1", kind: "started", agentThreadId: "hosted", model: "gpt-6.1-sol" });
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "hosted", parentThreadId: "main", preview: "Find tests" } } });
  item(state, run, "hosted", { type: "subAgentActivity", id: "hosted2", kind: "started", agentThreadId: "nested" });
  item(state, run, "main", { type: "subAgentActivity", id: "hosted3", kind: "completed", agentThreadId: "hosted" });
  item(state, run, "hosted", { type: "subAgentActivity", id: "hosted4", kind: "interrupted", agentThreadId: "nested" });
  const agents = calls(state, run);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].message.content[0].input.model, "gpt-6.1-sol");
  assert.equal(agents[1].parent_tool_use_id, "codex-agent-hosted");
  const all = messages(state, run);
  assert.ok(all.some((m) => m.subtype === "task_started" && m.prompt === "Find tests"));
  assert.equal(all.at(-1).status, "stopped");
});

test("codex_failed_spawns_and_child_failures_dont_finish_the_parent", () => {
  const [state, run] = running();
  item(state, run, "main", {
    type: "collabAgentToolCall",
    id: "bad-spawn",
    tool: "spawnAgent",
    status: "failed",
    receiverThreadIds: [],
    agentsStates: { missing: { status: "notFound", message: "No agent available" } },
  });
  assert.equal(calls(state, run)[0].message.content[0].name, "spawnAgent");
  assert.ok(messages(state, run).some((m) => m.message?.content?.[0]?.is_error === true));
  // Internal compact/review agents must never become the main session.
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "review", source: { subAgent: "review" } } } });
  event(state, run, "turn/completed", "child", { turn: { id: "child-turn", status: "failed", error: { message: "Child failed" } } });
  assert.ok(!saw_result(state, run));
  assert.equal(session(state, run), "main");
  event(state, run, "turn/completed", "main", { turn: { id: "main-turn", status: "completed" } });
  assert.ok(saw_result(state, run));
});
