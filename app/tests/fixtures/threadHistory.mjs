// A thread with a bit of everything the thread view draws, as an agent and the board store its messages: the board's
// events, tool calls and their results, prompts (allowed, denied, waiting), subagents (one in the background), a
// question, a plan, the board's own question, turns' ends, an API error, a compaction and a routine's report. The thread
// view on items is checked against the view on messages with it (itemModel.test.mjs, ui/itemThread.test.mjs).

/** A thread's messages, as an agent and the board store them. */
export function threadHistory(taskId = "t") {
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: taskId, kind, data, created_at: `2026-10-26T07:${String(out.length).padStart(2, "0")}:00.000Z` });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, session_id: "s", message: { content } });
  const call = (id, name, input = {}, parent = null) => assistant([{ type: "tool_use", id, name, input }], parent);
  const result = (id, content, parent = null, extra = {}) =>
    add("claude", { type: "user", parent_tool_use_id: parent, session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
  add("user", { text: "Start working on this task.", auto: true, start: true });
  add("event", { level: "info", text: "Setting up worktree…", detail: null });
  add("event", { level: "warn", text: "Slow", detail: "It took a while" });
  assistant([{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Starting." }]);
  call("r1", "Read", { file_path: "/a" });
  call("r2", "Grep", { pattern: "x", path: "/src" });
  result("r1", [{ type: "text", text: "a" }]);
  result("r2", "no match", null, { is_error: true });
  call("m1", "mcp__gh__pr_view", { number: 3 });
  result("m1", "PR 3");
  call("h1", "mcp__huntaway__create_task", { title: "Next" });
  result("h1", "made");
  // A permission prompt, allowed, and one denied.
  call("b1", "Bash", { command: "ls" });
  add("permission", { status: "allowed", tool_use_id: "b1", tool_name: "Bash", input: { command: "ls" }, request_id: "p1" });
  result("b1", "a b");
  call("b2", "Bash", { command: "rm -rf /" });
  add("permission", { status: "denied", tool_use_id: "b2", tool_name: "Bash", input: { command: "rm -rf /" }, request_id: "p2", note: "No" });
  result("b2", "No", null, { is_error: true });
  // A subagent, with a prompt of its own, and its report.
  call("A1", "Agent", { description: "Explore", prompt: "Explore the config.", subagent_type: "Explore" });
  add("claude", { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "A1", task_id: "k1", description: "Explore" });
  assistant([{ type: "text", text: "Subagent here." }], "A1");
  call("c1", "Bash", { command: "pwd" }, "A1");
  add("permission", { status: "allowed", tool_use_id: "c1", tool_name: "Bash", input: { command: "pwd" }, request_id: "p3" });
  add("claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Running pwd", usage: { tool_uses: 1 } });
  result("c1", "/repo", "A1");
  add("claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed" });
  add("claude", { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "A1", content: "Found it" }] },
    tool_use_result: { agentType: "Explore", totalToolUseCount: 1, status: "completed", resolvedModel: "haiku" } });
  // A background subagent.
  call("B1", "Agent", { description: "Away", prompt: "Go", run_in_background: true });
  add("claude", { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "B1", task_id: "k2", is_backgrounded: true });
  result("B1", "Async agent launched successfully");
  add("claude", { type: "system", subtype: "task_notification", task_id: "k2", status: "completed", summary: "Done away" });
  // A question, a plan approved into a mode, and the board's own question.
  const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multiSelect: false }];
  call("q1", "AskUserQuestion", { questions });
  add("permission", { status: "allowed", tool_use_id: "q1", tool_name: "AskUserQuestion", input: { questions }, request_id: "p4", answers: [["B"]] });
  result("q1", "B");
  call("x1", "ExitPlanMode", { plan: "# Plan\n\nDo it." });
  add("permission", { status: "allowed", tool_use_id: "x1", tool_name: "ExitPlanMode", input: { plan: "# Plan\n\nDo it." }, request_id: "p5", mode: "acceptEdits" });
  result("x1", "ok");
  add("question", { question: "Merge it?", options: [{ label: "Yes" }, { label: "No" }], multi_select: false, allow_other: true, call_id: "cq", status: "answered", answer: { choices: ["Yes"], text: null } });
  // A turn's end, the user's reply sent while it ran, an API error and an interruption.
  add("claude", { type: "result", subtype: "success", is_error: false, num_turns: 4, duration_ms: 1200, total_cost_usd: 0.25, result: "Starting." });
  add("user", { text: "And the docs", steered: true });
  add("claude", { type: "assistant", session_id: "s", is_api_error_message: true, error: "rate_limit", message: { content: [{ type: "text", text: "API Error: rate limited" }] } });
  add("claude", { type: "user", session_id: "s", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  add("claude", { type: "result", subtype: "error_during_execution", is_error: true, interrupted: true, duration_ms: 50 });
  // A compaction, its summary and the /compact run's turn, then a failed turn.
  add("claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 9000, post_tokens: 1200 } });
  add("claude", { type: "user", isSynthetic: true, message: { content: "The summary." } });
  add("claude", { type: "result", subtype: "success", num_turns: 0, is_error: false, duration_ms: 3000, total_cost_usd: 0.01 });
  add("claude", { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9 });
  // A routine's report, and a prompt still waiting.
  add("report", { automation: "Brief", task_id: "t2", key: "HA-2", outcome: "reported", text: "All **fine**" });
  call("w1", "Write", { file_path: "/c", content: "x" });
  add("permission", { status: "pending", tool_use_id: "w1", tool_name: "Write", input: { file_path: "/c", content: "x" }, request_id: "p6" });
  return out;
}
