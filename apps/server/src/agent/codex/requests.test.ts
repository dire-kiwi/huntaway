// A Codex run's requests on its output (requests.ts): approvals and questions as the board's permission prompts, the
// board's tools as dynamic tools through its dispatch, each answered on the run's input as a codex_response.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { sleep } from "../../util.ts";
import * as runs from "../runs.ts";
import * as mcp from "../../mcp.ts";
import * as permissions from "../../mcp/permissions.ts";
import { load_active, on_output } from "../runner.ts";
import { MCP_SERVER_NAME } from "../runner.ts";
import { control_call_id } from "../runner/requests.ts";
import { board_tools, prompt_answer, tool_answer } from "./requests.ts";

process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

/** A task whose agent is a Codex run that takes input and writes its requests to its output, with no process behind it. */
function running(mode: string | null = null): [Shared, Task, Run] {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = db.insert_task(state.db(), {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const run = db.insert_run(state.db(), task.id, "prompt");
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = runs.run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "");
  writeFileSync(join(dir, "input.jsonl"), "");
  writeFileSync(join(dir, "run.json"), JSON.stringify({ format: runs.RUN_FORMAT }));
  writeFileSync(
    join(dir, "codex.json"),
    JSON.stringify({ cwd: "/w", approval_policy: "untrusted", approvals_reviewer: "user", sandbox: "workspace-write", requests_on_output: true }),
  );
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  const t = state.update_task(task.id, [
    ["running", true],
    ["permission_mode", mode],
  ])!;
  return [state, t, db.get_run(state.db(), run.id)!];
}

/** The adapter writes `lines` to the run's output. */
function output(state: Shared, run: Run, lines: any[]) {
  const offset = db.get_run(state.db(), run.id)!.out_offset;
  on_output(state, run.id, offset, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

/** The answers the adapter has been sent. */
function responses(state: Shared, run: Run): any[] {
  const text = readFileSync(join(runs.run_dir(state, run.id), "input.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === "codex_response");
}

async function answered(state: Shared, run: Run, n: number): Promise<any[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = responses(state, run);
    if (r.length >= n) return r;
    assert.ok(Date.now() < deadline, `timed out waiting for ${n} answers, have ${JSON.stringify(r)}`);
    await sleep(5);
  }
}

async function quiet(state: Shared, run: Run, n: number) {
  await sleep(30);
  assert.equal(responses(state, run).length, n, JSON.stringify(responses(state, run)));
}

const request_of = (state: Shared, run: Run, id: number) =>
  db.one<{ id: string; status: string; tool_name: string; input: string; message_id: number }>(
    state.db(),
    "SELECT id, status, tool_name, input, message_id FROM permission_requests WHERE call_id=?1",
    control_call_id(run.id, `codex:${id}`),
  );

const approval = (id: number, command: string, item = `item-${id}`) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: { threadId: "main", turnId: "t1", itemId: item, command: `/usr/bin/bash -lc '${command}'`, cwd: "/w", reason: "To build" },
});

test("an_approval_on_the_output_is_a_prompt_answered_on_the_input", async () => {
  const [state, task, run] = running();
  output(state, run, [approval(0, "make")]);
  const req = request_of(state, run, 0)!;
  assert.deepEqual([req.status, req.tool_name, JSON.parse(req.input)], ["pending", "Bash", { command: "make", cwd: "/w", description: "To build" }]);
  assert.equal(db.get_task(state.db(), task.id)!.attention_reason, "Approve Bash?");
  await quiet(state, run, 0);
  permissions.decide(state, req.id, true, false, null);
  assert.deepEqual(await answered(state, run, 1), [{ type: "codex_response", id: 0, result: { decision: "accept" } }]);

  // Denied.
  output(state, run, [approval(1, "rm -rf /")]);
  permissions.decide(state, request_of(state, run, 1)!.id, false, false, "Not that");
  assert.deepEqual((await answered(state, run, 2))[1], { type: "codex_response", id: 1, result: { decision: "decline" } });

  // A file change, with the item the adapter sends it with; more permissions, granted as asked.
  const item = { type: "fileChange", id: "fc", changes: [{ path: "/w/a", kind: { type: "add" }, diff: "+x" }] };
  output(state, run, [{ id: 2, method: "item/fileChange/requestApproval", params: { threadId: "main", itemId: "fc", reason: "New file" }, item }]);
  const fc = request_of(state, run, 2)!;
  assert.deepEqual(JSON.parse(fc.input), { changes: [{ path: "/w/a", kind: "add", move_path: null, diff: "+x" }], reason: "New file" });
  permissions.decide(state, fc.id, true, false, null);
  assert.deepEqual((await answered(state, run, 3))[2].result, { decision: "accept" });
  output(state, run, [
    { id: 3, method: "item/permissions/requestApproval", params: { threadId: "main", itemId: "p", permissions: { network: true }, reason: "fetch" } },
  ]);
  permissions.decide(state, request_of(state, run, 3)!.id, true, false, null);
  assert.deepEqual((await answered(state, run, 4))[3].result, { permissions: { network: true }, scope: "turn" });
  // A request read again (its offset wasn't saved) finds the same call, which was answered: it isn't answered again.
  db.run(state.db(), "UPDATE runs SET out_offset=0 WHERE id=?1", run.id);
  output(state, run, [approval(0, "make")]);
  await quiet(state, run, 4);
});

test("codex_questions_are_the_request_user_input_prompt", async () => {
  const [state, , run] = running();
  const questions = [
    { id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red" }, { label: "Blue" }] },
  ];
  output(state, run, [{ id: 7, method: "item/tool/requestUserInput", params: { threadId: "main", itemId: "call_q", questions } }]);
  const req = request_of(state, run, 7)!;
  assert.equal(req.tool_name, permissions.CODEX_QUESTIONS);
  permissions.answer(state, req.id, true, false, null, { answers: [["Blue"]] });
  assert.deepEqual((await answered(state, run, 1))[0], { type: "codex_response", id: 7, result: { answers: { color: { answers: ["Blue"] } } } });
});

test("the_boards_tools_are_dynamic_tools_called_through_its_dispatch", async () => {
  const [state, task, run] = running();
  // One namespace, named for the board's server, with every tool the board's MCP server has.
  const ns = board_tools(false);
  assert.deepEqual([ns.type, ns.name], ["namespace", MCP_SERVER_NAME]);
  assert.deepEqual(
    ns.tools.map((t: any) => t.name),
    mcp.tool_names(false).filter((n) => n !== "permission_prompt"),
  );
  assert.ok(ns.tools.every((t: any) => t.type === "function" && typeof t.description === "string" && t.inputSchema));
  assert.ok(board_tools(true).tools.some((t: any) => t.name === "submit_review"));

  const call = (id: number, tool: string, args: any, namespace: string | null = MCP_SERVER_NAME) => ({
    id,
    method: "item/tool/call",
    params: { threadId: "main", turnId: "t1", callId: `call-${id}`, namespace, tool, arguments: args },
  });
  output(state, run, [call(1, "get_task", { task_id: task.id })]);
  const [r] = await answered(state, run, 1);
  assert.equal(r.id, 1);
  assert.equal(r.result.success, true, JSON.stringify(r));
  assert.equal(JSON.parse(r.result.contentItems[0].text).id, task.id);
  // Recorded as the run's call, done.
  assert.equal(db.value(state.db(), "SELECT status FROM mcp_calls WHERE id=?1", control_call_id(run.id, "codex:1")), "done");
  // An error is the call's failure, as the MCP server's would be.
  output(state, run, [call(2, "get_task", { task_id: "NOPE-1" })]);
  const failed = (await answered(state, run, 2))[1].result;
  assert.equal(failed.success, false);
  assert.match(failed.contentItems[0].text, /^Error: /);
  // Another namespace's (or none) isn't the board's.
  output(state, run, [call(3, "lookup", {}, null), call(4, "lookup", {}, "other")]);
  const [, , none, other] = await answered(state, run, 4);
  assert.deepEqual(none.result, { contentItems: [{ type: "inputText", text: "Error: There's no tool lookup." }], success: false });
  assert.deepEqual(other.result.success, false);
  // A method the board doesn't take is an error.
  output(state, run, [{ id: 5, method: "item/somethingNew", params: {} }]);
  assert.deepEqual((await answered(state, run, 5))[4].error, { code: -32601, message: "Method not supported by Huntaway: item/somethingNew" });
});

test("a_wait_codex_leaves_to_the_user_is_asked_about_as_its_command", async () => {
  // A session from before its tools were dynamic tools has them on the board's MCP server, whose wait Codex's reviewer
  // may leave to the user (see Spec::review_waits).
  const [state, , run] = running();
  const elicit = (id: number, tool: string, params: any) => {
    const message = `Allow the ${MCP_SERVER_NAME} MCP server to run tool "${tool}"?`;
    const p = {
      threadId: "main",
      serverName: MCP_SERVER_NAME,
      mode: "form",
      message,
      requestedSchema: { type: "object", properties: {} },
      _meta: { tool_params: params },
    };
    output(state, run, [{ id, method: "mcpServer/elicitation/request", params: p }]);
  };
  elicit(1, "wait", { reason: "waiting for CI", command: " gh pr checks 1 " });
  const req = request_of(state, run, 1)!;
  assert.deepEqual([req.tool_name, JSON.parse(req.input)], ["Bash", { command: "gh pr checks 1", description: "Run while waiting: waiting for CI" }]);
  permissions.decide(state, req.id, false, false, null);
  assert.deepEqual((await answered(state, run, 1))[0].result, { action: "decline", content: null });
  // A wait without a command, and the board's other tools, need no approval.
  elicit(2, "wait", { seconds: 60, command: "" });
  elicit(3, "get_task", { task: "IA-1" });
  const [, a, b] = await answered(state, run, 3);
  assert.deepEqual(
    [a.result, b.result],
    [
      { action: "accept", content: {} },
      { action: "accept", content: {} },
    ],
  );
  assert.equal(request_of(state, run, 2), undefined);
  // Without its arguments, a wait is asked about as itself.
  elicit(4, "wait", null);
  assert.equal(request_of(state, run, 4)!.tool_name, `mcp__${MCP_SERVER_NAME}__wait`);
});

test("a_request_codex_stops_waiting_for_expires_its_prompt", async () => {
  const [state, task, run] = running();
  output(state, run, [approval(0, "make")]);
  const req = request_of(state, run, 0)!;
  // The adapter says so only of one the board hasn't answered.
  output(state, run, [{ method: "serverRequest/resolved", params: { threadId: "main", requestId: 0 } }]);
  assert.equal(request_of(state, run, 0)!.status, "expired");
  assert.equal(db.get_task(state.db(), task.id)!.status, "in_progress");
  await quiet(state, run, 0);
  assert.equal(req.message_id > 0, true);
});

test("after_a_restart_a_waiting_approval_is_asked_again_and_answered", async () => {
  const [state, task, run] = running();
  output(state, run, [approval(0, "make")]);
  assert.equal(request_of(state, run, 0)!.status, "pending");
  // The server restarts: its waiters are gone, and the run's output is followed from its saved offset, past the request.
  state.perm_waiters.clear();
  state.calls_inflight.clear();
  state.runs.delete(task.id);
  load_active(state);
  await quiet(state, run, 0);
  const req = request_of(state, run, 0)!;
  assert.equal(req.status, "pending");
  permissions.decide(state, req.id, true, false, null);
  assert.deepEqual((await answered(state, run, 1))[0], { type: "codex_response", id: 0, result: { decision: "accept" } });
  await quiet(state, run, 1);
});

test("answers_as_codex_takes_them", () => {
  const allow = { behavior: "allow", updatedInput: { answers: { q: { answers: ["a"] } } } };
  const deny = { behavior: "deny", message: "no" };
  assert.deepEqual(prompt_answer({ id: 1, method: "item/commandExecution/requestApproval" }, allow), { decision: "accept" });
  assert.deepEqual(prompt_answer({ id: 1, method: "item/fileChange/requestApproval" }, deny), { decision: "decline" });
  assert.deepEqual(prompt_answer({ id: 1, method: "item/permissions/requestApproval", permissions: { x: 1 } }, deny), { permissions: {}, scope: "turn" });
  assert.deepEqual(prompt_answer({ id: 1, method: "mcpServer/elicitation/request" }, allow), { action: "accept", content: {} });
  assert.deepEqual(prompt_answer({ id: 1, method: "item/tool/requestUserInput" }, allow), { answers: { q: { answers: ["a"] } } });
  assert.deepEqual(prompt_answer({ id: 1, method: "item/tool/requestUserInput" }, deny), { answers: {} });
  assert.deepEqual(tool_answer({ ok: { a: 1 } }), { contentItems: [{ type: "inputText", text: '{\n  "a": 1\n}' }], success: true });
  assert.deepEqual(tool_answer({ err: "boom" }), { contentItems: [{ type: "inputText", text: "Error: boom" }], success: false });
});
