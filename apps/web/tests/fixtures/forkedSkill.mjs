// The shape Claude emitted for ODS-9's /code-review: a Skill call, a local_agent lifecycle,
// and child messages keyed by the Skill's tool_use_id, without an Agent/Task call.
export function forkedSkillMessages(taskId = "t", parent = null) {
  const out = [];
  const add = (data, kind = "claude") => out.push({ id: out.length + 1, task_id: taskId, kind, data, created_at: new Date(out.length * 1000).toISOString() });
  add({ type: "assistant", parent_tool_use_id: parent, message: { content: [
    { type: "tool_use", id: "skill-review", name: "Skill", input: { skill: "code-review", args: "low 139" } },
  ] } });
  add({ type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "skill-review", task_id: "review-child",
    description: "/code-review", prompt: "Review PR 139 for correctness bugs.", subagent_type: "general-purpose",
    ambient: true, skip_transcript: true, is_backgrounded: false });
  add({ type: "user", parent_tool_use_id: "skill-review", message: { content: [{ type: "text", text: "Review PR 139 for correctness bugs." }] } });
  add({ type: "assistant", parent_tool_use_id: "skill-review", message: { content: [
    { type: "tool_use", id: "review-diff", name: "Bash", input: { command: "git diff main...HEAD" } },
  ] } });
  add({ status: "pending", tool_use_id: "review-diff", tool_name: "Bash", input: { command: "git diff main...HEAD" }, request_id: "review-permission" }, "permission");
  add({ type: "user", parent_tool_use_id: "skill-review", message: { content: [
    { type: "tool_result", tool_use_id: "review-diff", content: "The reviewed diff." },
  ] } });
  add({ type: "system", subtype: "task_notification", task_id: "review-child", tool_use_id: "skill-review", status: "completed", summary: "/code-review" });
  add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill-review",
    content: 'Skill "code-review" completed (forked execution).\n\nResult:\nNo runtime bugs found.' }] },
    tool_use_result: { agentId: "review-child", status: "forked" } });
  add({ type: "assistant", message: { content: [{ type: "text", text: "Main reviewer summary." }] } });
  return out;
}
