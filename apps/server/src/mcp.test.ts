// Port of the tests in server/src/mcp.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Ctx, check_args, tool_names } from "./mcp.ts";
import * as mcp from "./mcp.ts";

test("helper_advertises_task_field_support_outside_the_tool_arguments", async () => {
  // A server that answers with the call it was sent.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      assert.equal(req.url, "/api/internal/mcp");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const ctx = new Ctx(url, "", "run");
    const args = { task_id: "IA-1" };
    const sent = await ctx.call("get_task", args);
    assert.equal(sent.task_fields, true);
    assert.deepEqual(sent.args, args);
    assert.equal(sent.run_id, "run");
    assert.ok(tool_names(false).includes("get_task_field"));
  } finally {
    server.close();
  }
});

test("reviewers_only_get_the_read_only_tools_and_submit_review", () => {
  const [task, review] = [tool_names(false), tool_names(true)];
  assert.ok(task.includes("update_project") && !task.includes("submit_review"));
  const want = ["get_project", "get_task", "get_task_field", "list_projects", "list_tasks", "permission_prompt", "request_user_input", "submit_review", "wait"];
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
  // Claude Code's own; and unknown tools are left to the server to refuse.
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
