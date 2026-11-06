// Port of the tests in server/src/mcp.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { check_args, tool_names } from "./mcp.ts";
import * as mcp from "./mcp.ts";

test("reviewers_only_get_the_read_only_tools_and_submit_review", () => {
  const [task, review] = [tool_names(false), tool_names(true)];
  assert.ok(task.includes("update_project") && !task.includes("submit_review"));
  const want = ["get_project", "get_task", "get_task_field", "list_projects", "list_tasks", "request_user_input", "submit_review", "wait"];
  assert.deepEqual([...review].sort(), want);
  assert.ok(task.includes("delete_task"));
});

test("checks_arguments_against_the_schema", () => {
  assert.equal(check_args("get_task", { task_id: "IA-1", profile: "work" }), null);
  assert.equal(check_args("get_task_field", { task_id: "IA-1", field: "description", offset: 2, limit: 10 }), null);
  assert.ok(check_args("get_task_field", { task_id: "IA-1" })!.includes("needs field"));
  assert.ok(check_args("get_task_field", { task_id: "IA-1", field: "description", start: 1 })!.includes("has no argument"));
  assert.equal(check_args("list_projects", null), null);
  assert.equal(check_args("list_tasks", { project_id: "all", host: "laptop" }), null);
  assert.ok(check_args("get_task", { task: "IA-1" })!.includes("its arguments are profile, task_id"));
  assert.ok(check_args("update_task", { task_id: "", status: "done" })!.startsWith("update_task needs task_id"));
  assert.notEqual(check_args("list_tasks", { project: "issue-agent" }), null);
  assert.ok(check_args("submit_review", { verdict: "pass", summary: "ok" })!.includes("serious_issues"));
  // Not a tool of the server's any more (the board's own prompts), and unknown tools are left to the server to refuse.
  assert.ok(!tool_names(false).includes("permission_prompt"));
  assert.equal(check_args("permission_prompt", { tool_name: "Bash", input: {}, extra: 1 }), null);
  assert.equal(check_args("no_such_tool", { x: 1 }), null);
});

// (Not in Rust, where mcp.rs reads these from their modules: the helper keeps copies so it doesn't load the server.)
test("the_helpers_constants_match_their_modules", async () => {
  const db = await import("./db.ts");
  const questions = await import("./mcp/questions.ts");
  const wait = await import("./mcp/wait.ts");
  const pr_watch = await import("./mcp/pr_watch.ts");
  const automations = await import("./integrations/automations.ts");
  const workflows = await import("./integrations/workflows.ts");
  const tools = await import("./mcp/tools.ts");
  assert.deepEqual(mcp.STATUSES, db.STATUSES);
  assert.deepEqual(mcp.PERMISSION_MODES, db.PERMISSION_MODES);
  assert.deepEqual(mcp.RESOLUTIONS, db.RESOLUTIONS);
  assert.deepEqual(mcp.LABELS, db.LABELS);
  assert.deepEqual(mcp.TASK_TYPES, db.TASK_TYPES);
  assert.deepEqual(mcp.THREAD_EFFORTS, db.THREAD_EFFORTS);
  assert.equal(mcp.MAX_OPTIONS, questions.MAX_OPTIONS);
  assert.equal(mcp.WAIT_DEFAULT_SECS, (wait as any).DEFAULT_SECS);
  assert.equal(mcp.WAIT_MAX_SECS, (wait as any).MAX_SECS);
  assert.equal(mcp.WAIT_UNWATCHED_MAX_SECS, (wait as any).UNWATCHED_MAX_SECS);
  assert.deepEqual(mcp.PR_EVENTS, pr_watch.EVENTS);
  assert.equal(mcp.MIN_INTERVAL_MINUTES, automations.MIN_INTERVAL_MINUTES);
  assert.equal(mcp.WORKFLOW_MAX_ROUNDS, workflows.MAX_ROUNDS);
  assert.equal(mcp.TASK_FIELD_DEFAULT_LIMIT, tools.TASK_FIELD_DEFAULT_LIMIT);
  assert.equal(mcp.TASK_FIELD_MAX_LIMIT, tools.TASK_FIELD_MAX_LIMIT);
});
