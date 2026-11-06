import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSubagents } from "../src/subagents.ts";
import { forkedSkillMessages } from "./fixtures/forkedSkill.mjs";

test("a forked Skill's local_agent lifecycle discovers its subagent without an Agent call", () => {
  const messages = forkedSkillMessages("t", "outer-agent");
  assert.deepEqual(buildSubagents(messages.slice(0, 1), true), [], "ordinary Skill calls aren't subagents");
  const [running] = buildSubagents(messages.slice(0, 5), true);
  assert.ok(running, "task_started discovers the forked Skill");
  assert.equal(running.id, "skill-review");
  assert.equal(running.description, "/code-review");
  assert.equal(running.prompt, "Review PR 139 for correctness bugs.");
  assert.equal(running.agentType, "general-purpose");
  assert.equal(running.parent, "outer-agent");
  assert.equal(running.messageId, messages[0].id);
  assert.equal(running.startedAt, messages[0].created_at);
  assert.equal(running.background, false);
  assert.equal(running.awaitingApproval, true);
  const done = buildSubagents(messages, false);
  assert.equal(done.length, 1);
  assert.equal(done[0].status, "completed");
  assert.equal(done[0].endedAt, messages[6].created_at);
});

test("background shell lifecycle events aren't subagents", () => {
  const t = thread();
  t.add({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "make" } }] } });
  t.add({ type: "system", subtype: "task_started", task_type: "local_bash", task_id: "shell-task", tool_use_id: "shell" });
  assert.deepEqual(t.agents(), []);
});

function thread() {
  const messages = [];
  const add = (data, kind = "claude") => messages.push({ id: messages.length + 1, kind, data, created_at: new Date(messages.length * 1000).toISOString() });
  const start = (id, parent = null, input = {}) => add({ type: "assistant", parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name: "Agent", input: { run_in_background: true, ...input } }] } });
  const status = (id, status, summary) => add({ type: "system", subtype: "task_notification", tool_use_id: id, status, summary });
  const update = (id, status) => add({ type: "system", subtype: "task_updated", tool_use_id: id, patch: { status } });
  return { messages, add, start, status, update, agents: (running = true) => buildSubagents(messages, running) };
}

test("Codex child metadata can arrive after its stable row, without creating another agent", () => {
  const t = thread();
  t.start("codex-agent-child");
  t.add({ type: "system", subtype: "task_started", tool_use_id: "codex-agent-child", task_id: "child", prompt: "Inspect config", description: "Inspect config",
    model: "gpt-6.1-sol", subagent_type: "explorer", parent_tool_use_id: "codex-agent-parent" });
  t.start("codex-agent-child");
  for (const name of ["wait", "sendInput", "sendMessage", "resumeAgent", "followupTask", "closeAgent"]) {
    t.add({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input: { receiver_thread_ids: ["child"] } }] } });
    t.add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: name, content: "done" }] } });
  }
  const [s] = t.agents();
  assert.equal(t.agents().length, 1);
  assert.equal(s.parent, "codex-agent-parent");
  assert.equal(s.prompt, "Inspect config");
  assert.equal(s.description, "Inspect config");
  assert.equal(s.model, "gpt-6.1-sol");
  assert.equal(s.agentType, "explorer");
  assert.equal(s.status, "running", "a spawn or send returning doesn't finish its child");
});

test("a Codex follow-up reopens a completed child and replaces its old report", () => {
  const t = thread();
  t.start("codex-agent-child", null, { prompt: "Inspect config" });
  t.status("codex-agent-child", "completed", "Initial report");
  assert.equal(t.agents()[0].status, "completed");
  assert.equal(t.agents()[0].summary, "Initial report");
  assert.ok(t.agents()[0].endedAt);
  t.update("codex-agent-child", "running");
  assert.equal(t.agents()[0].status, "running");
  assert.equal(t.agents()[0].summary, undefined);
  assert.equal(t.agents()[0].endedAt, undefined);
  t.status("codex-agent-child", "completed", "Follow-up report");
  t.status("codex-agent-child", "stopped");
  assert.equal(t.agents()[0].status, "completed", "closing a completed thread preserves its outcome");
  assert.equal(t.agents()[0].summary, "Follow-up report");
});

test("a child's pending permission can arrive before its row and survives status updates", () => {
  const t = thread();
  t.add({ status: "pending", tool_use_id: "bash" }, "permission");
  t.add({ type: "assistant", parent_tool_use_id: "codex-agent-child", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "make" } }] } });
  t.start("codex-agent-child");
  t.update("codex-agent-child", "running");
  assert.equal(t.agents()[0].awaitingApproval, true);
  t.messages[0].data.status = "allowed";
  assert.equal(t.agents()[0].awaitingApproval, undefined);
});

test("failed, interrupted and unfinished Codex children have separate outcomes", () => {
  const t = thread();
  for (const id of ["failed", "interrupted", "unfinished"]) t.start(id);
  t.status("failed", "failed", "Child error");
  t.status("interrupted", "stopped");
  assert.deepEqual(t.agents(false).map((s) => s.status), ["failed", "stopped", "stopped"]);
});

