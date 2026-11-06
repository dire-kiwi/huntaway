// Permission prompts over Claude Code's control protocol (requests.ts): the policy of mcp/permissions.ts, asked on the
// run's output and answered on its input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { sleep } from "../../util.ts";
import * as runs from "../runs.ts";
import * as permissions from "../../mcp/permissions.ts";
import { BACKGROUND_GRACE, FOLLOW_UP_GRACE, finish, load_active, on_output } from "../runner.ts";
import { MCP_PROTOCOL, control_call_id, initialize_line } from "./requests.ts";

process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

/** A task whose agent is running a run that takes input and asks on its output, with no process behind it. */
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
  state.runs.set(task.id, { run_id: run.id, cancel: null });
  const t = state.update_task(task.id, [["running", true], ["permission_mode", mode]])!;
  return [state, t, db.get_run(state.db(), run.id)!];
}

/** The agent writes `lines` to its output. */
function output(state: Shared, run: Run, lines: any[]) {
  const offset = db.get_run(state.db(), run.id)!.out_offset;
  on_output(state, run.id, offset, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

/** The control responses the agent has been sent. */
function responses(state: Shared, run: Run): any[] {
  const text = readFileSync(join(runs.run_dir(state, run.id), "input.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === "control_response")
    .map((l) => l.response);
}

/** Wait for the agent to have been sent `n` control responses, and return them. */
async function answered(state: Shared, run: Run, n: number): Promise<any[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = responses(state, run);
    if (r.length >= n) return r;
    assert.ok(Date.now() < deadline, `timed out waiting for ${n} responses, have ${JSON.stringify(r)}`);
    await sleep(5);
  }
}

/** Let what's pending run, then check nothing more was sent. */
async function quiet(state: Shared, run: Run, n: number) {
  await sleep(30);
  assert.equal(responses(state, run).length, n, JSON.stringify(responses(state, run)));
}

const can_use_tool = (request_id: string, tool_name: string, input: any, tool_use_id = `toolu_${request_id}`) => ({
  type: "control_request",
  request_id,
  request: { subtype: "can_use_tool", tool_name, input, tool_use_id, permission_suggestions: [] },
});

const request_of = (state: Shared, run: Run, request_id: string) =>
  db.one<{ id: string; status: string; tool_name: string; message_id: number }>(
    state.db(),
    "SELECT id, status, tool_name, message_id FROM permission_requests WHERE call_id=?1",
    control_call_id(run.id, request_id),
  );

const message_of = (state: Shared, id: number) => testing.message(state.db(), id)!.data;

const reload = (state: Shared, id: string) => db.get_task(state.db(), id)!;

test("a_prompt_on_the_output_is_asked_and_answered_on_the_input", async () => {
  const [state, task, run] = running();
  output(state, run, [can_use_tool("r1", "Bash", { command: "make" })]);
  // Asked as the helper's prompt was: a request, a thread message, and the task waiting on it.
  const req = request_of(state, run, "r1")!;
  assert.deepEqual([req.status, req.tool_name], ["pending", "Bash"]);
  const shown = message_of(state, req.message_id);
  assert.deepEqual([shown.tool_name, shown.input, shown.tool_use_id, shown.status], ["Bash", { command: "make" }, "toolu_r1", "pending"]);
  let t = reload(state, task.id);
  assert.deepEqual([t.status, t.attention_reason], ["needs_attention", "Approve Bash?"]);
  assert.equal(permissions.pending(state, task.id).length, 1);
  await quiet(state, run, 0);

  permissions.decide(state, req.id, true, false, null);
  const [r] = await answered(state, run, 1);
  assert.deepEqual(r, { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "make" } } });
  t = reload(state, task.id);
  assert.deepEqual([t.status, t.attention_reason], ["in_progress", null]);
  assert.equal(db.value(state.db(), "SELECT status FROM mcp_calls WHERE id=?1", control_call_id(run.id, "r1")), "done");

  // Denied, with what the user said.
  output(state, run, [can_use_tool("r2", "Bash", { command: "rm -rf /" })]);
  permissions.decide(state, request_of(state, run, "r2")!.id, false, false, "Not that");
  const r2 = (await answered(state, run, 2))[1];
  assert.deepEqual(r2.response, { behavior: "deny", message: "Not that" });
  assert.equal(message_of(state, request_of(state, run, "r2")!.message_id).status, "denied");
  await quiet(state, run, 2);
});

test("always_allows_the_tool_from_then_on", async () => {
  const [state, task, run] = running();
  output(state, run, [can_use_tool("r1", "Edit", { file_path: "/a" })]);
  permissions.decide(state, request_of(state, run, "r1")!.id, true, true, null);
  await answered(state, run, 1);
  assert.deepEqual(reload(state, task.id).auto_allow, ["Edit"]);
  // The next is answered without asking.
  output(state, run, [can_use_tool("r2", "Edit", { file_path: "/b" })]);
  const r = (await answered(state, run, 2))[1];
  assert.deepEqual(r.response, { behavior: "allow", updatedInput: { file_path: "/b" } });
  assert.equal(request_of(state, run, "r2"), undefined);
  // A question isn't, though AskUserQuestion was always allowed.
  state.update_task(task.id, [["auto_allow", JSON.stringify(["AskUserQuestion"])]]);
  output(state, run, [can_use_tool("r3", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "a" }] }] })]);
  assert.equal(request_of(state, run, "r3")!.status, "pending");
  await quiet(state, run, 2);
});

test("the_threads_mode_now_decides_what_it_asks", async () => {
  // Don't ask denies at once, and so does a prompt raised in it.
  {
    const [state, , run] = running("dontAsk");
    output(state, run, [can_use_tool("r1", "Bash", { command: "ls" })]);
    const [r] = await answered(state, run, 1);
    assert.deepEqual(r.response, { behavior: "deny", message: permissions.DONT_ASK_DENIAL });
  }
  // Bypass allows, but asks questions.
  {
    const [state, , run] = running("bypassPermissions");
    output(state, run, [can_use_tool("r1", "Bash", { command: "ls" })]);
    assert.equal((await answered(state, run, 1))[0].response.behavior, "allow");
    output(state, run, [can_use_tool("q1", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "a" }] }] })]);
    assert.equal(request_of(state, run, "q1")!.status, "pending");
    await quiet(state, run, 1);
  }
  // A prompt waiting when the mode changes is answered as the new mode answers it.
  {
    const [state, task, run] = running();
    output(state, run, [can_use_tool("r1", "Bash", { command: "ls" })]);
    const t = state.update_task(task.id, [["permission_mode", "bypassPermissions"]])!;
    permissions.apply_mode_to_pending(state, t);
    assert.equal((await answered(state, run, 1))[0].response.behavior, "allow");
    assert.deepEqual([reload(state, task.id).status, reload(state, task.id).attention_reason], ["in_progress", null]);
  }
});

test("a_plan_approved_into_a_mode_switches_claude_to_it", async () => {
  const [state, task, run] = running("plan");
  const plan = { plan: "# Plan: add a cache\n\n1. Do it" };
  output(state, run, [can_use_tool("p1", "ExitPlanMode", plan)]);
  assert.equal(reload(state, task.id).attention_reason, "Plan ready for approval: add a cache");
  // Sent back first.
  permissions.answer(state, request_of(state, run, "p1")!.id, false, false, null, { feedback: "Add tests" });
  const [back] = await answered(state, run, 1);
  assert.equal(back.response.behavior, "deny");
  assert.ok(back.response.message.endsWith("Their feedback:\n\nAdd tests"), back.response.message);
  output(state, run, [can_use_tool("p2", "ExitPlanMode", plan)]);
  permissions.answer(state, request_of(state, run, "p2")!.id, true, false, null, { mode: "acceptEdits" });
  const r = (await answered(state, run, 2))[1];
  assert.deepEqual(r.response, {
    behavior: "allow",
    updatedInput: plan,
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  assert.equal(reload(state, task.id).permission_mode, "acceptEdits");
});

test("a_questions_answers_go_back_in_its_input", async () => {
  const [state, task, run] = running();
  const input = { questions: [{ question: "Which season?", header: "Season", multiSelect: false, options: [{ label: "Summer" }, { label: "Winter" }] }] };
  output(state, run, [can_use_tool("q1", "AskUserQuestion", input)]);
  assert.equal(reload(state, task.id).attention_reason, "Which season?");
  permissions.answer(state, request_of(state, run, "q1")!.id, true, false, null, { answers: [["Winter"]] });
  const [r] = await answered(state, run, 1);
  assert.deepEqual(r.response, { behavior: "allow", updatedInput: { ...input, answers: { "Which season?": "Winter" } } });
  assert.deepEqual(message_of(state, request_of(state, run, "q1")!.message_id).answers, [["Winter"]]);
});

test("a_prompt_read_again_is_asked_and_answered_once", async () => {
  const [state, , run] = running();
  const line = `${JSON.stringify(can_use_tool("r1", "Bash", { command: "ls" }))}\n`;
  on_output(state, run.id, 0, line);
  // The server stopped before it saved how far it read: the line comes again.
  db.run(state.db(), "UPDATE runs SET out_offset=0 WHERE id=?1", run.id);
  on_output(state, run.id, 0, line);
  assert.equal(db.value<number>(state.db(), "SELECT COUNT(*) FROM permission_requests"), 1);
  permissions.decide(state, request_of(state, run, "r1")!.id, true, false, null);
  await answered(state, run, 1);
  // And once more after it was answered (and recorded): Claude has its answer.
  db.run(state.db(), "UPDATE runs SET out_offset=0 WHERE id=?1", run.id);
  on_output(state, run.id, 0, line);
  await quiet(state, run, 1);
});

test("after_a_restart_an_open_prompt_is_found_again_and_answered", async () => {
  const [state, task, run] = running();
  output(state, run, [can_use_tool("r1", "Bash", { command: "ls" }), can_use_tool("r2", "Read", { file_path: "/a" })]);
  permissions.decide(state, request_of(state, run, "r2")!.id, true, false, null);
  await answered(state, run, 1);
  // The server restarts: its waiters are gone, and the run's output is followed from its saved offset, past the request.
  state.perm_waiters.clear();
  state.calls_inflight.clear();
  state.runs.delete(task.id);
  load_active(state);
  assert.equal(reload(state, task.id).status, "needs_attention");
  await quiet(state, run, 1);
  permissions.decide(state, request_of(state, run, "r1")!.id, false, false, "No");
  const all = await answered(state, run, 2);
  assert.deepEqual(all[1], { subtype: "success", request_id: "r1", response: { behavior: "deny", message: "No" } });
  await quiet(state, run, 2);
});

test("a_prompt_claude_cancels_expires_unanswered", async () => {
  const [state, task, run] = running();
  output(state, run, [can_use_tool("r1", "Bash", { command: "ls" })]);
  output(state, run, [{ type: "control_cancel_request", request_id: "r1" }]);
  const req = request_of(state, run, "r1")!;
  assert.equal(req.status, "expired");
  assert.equal(message_of(state, req.message_id).status, "expired");
  assert.deepEqual([reload(state, task.id).status, reload(state, task.id).attention_reason], ["in_progress", null]);
  await quiet(state, run, 0);
  // A cancel for one already answered changes nothing.
  output(state, run, [can_use_tool("r2", "Bash", { command: "ls" })]);
  permissions.decide(state, request_of(state, run, "r2")!.id, true, false, null);
  await answered(state, run, 1);
  output(state, run, [{ type: "control_cancel_request", request_id: "r2" }]);
  assert.equal(request_of(state, run, "r2")!.status, "allowed");
});

test("a_prompt_whose_run_ended_expires_and_a_question_is_answered_by_message", async () => {
  const [state, task, run] = running();
  output(state, run, [can_use_tool("q1", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] })]);
  output(state, run, [can_use_tool("r1", "Bash", { command: "ls" })]);
  finish(state, run.id, "Ok");
  assert.equal(request_of(state, run, "q1")!.status, "expired");
  assert.equal(request_of(state, run, "r1")!.status, "expired");
  // Its input is closed by now, so nothing is written to it.
  writeFileSync(join(runs.run_dir(state, run.id), "input.closed"), "");
  await quiet(state, run, 0);
  // Answered late, the answer goes as a message, to the next run (one being prepared here, where no agent runs).
  const next = db.insert_run(state.db(), task.id, "prompt");
  state.runs.set(task.id, { run_id: next.id, cancel: null });
  assert.equal(permissions.answer(state, request_of(state, run, "q1")!.id, true, false, null, { answers: [["b"]] }), "allowed");
  assert.deepEqual(
    reload(state, task.id).steering.map((s) => [s.text, s.run_id]),
    [["My answer to the question you asked:\n\n- Which?\n  b", next.id]],
  );
  await quiet(state, run, 0);
});

test("other_control_requests_get_an_error", async () => {
  const [state, , run] = running();
  output(state, run, [{ type: "control_request", request_id: "m1", request: { subtype: "hook_callback", callback_id: "x", input: {} } }]);
  const [r] = await answered(state, run, 1);
  assert.equal(r.subtype, "error");
  assert.equal(r.request_id, "m1");
  assert.equal(db.value<number>(state.db(), "SELECT COUNT(*) FROM permission_requests"), 0);
});

// ---------- the board's tools as an in-process MCP server (HA-221) ----------

const mcp_message = (request_id: string, message: any, server_name = "huntaway") => ({
  type: "control_request",
  request_id,
  request: { subtype: "mcp_message", server_name, message },
});
const tool_call = (request_id: string, rpc_id: number, name: string, args: any) =>
  mcp_message(request_id, {
    jsonrpc: "2.0",
    id: rpc_id,
    method: "tools/call",
    params: { name, arguments: args, _meta: { "claudecode/toolUseId": `toolu_${request_id}`, progressToken: rpc_id } },
  });
/** What a board call's answer says, and whether it's an error. */
const said_by = (r: any): [string, boolean] => [r.response.mcp_response.result.content[0].text, r.response.mcp_response.result.isError === true];
const call_status = (state: Shared, run: Run, request_id: string) =>
  db.value<string>(state.db(), "SELECT status FROM mcp_calls WHERE id=?1", control_call_id(run.id, request_id));

/** A run of a review thread, as `running` makes them. */
function reviewing(): [Shared, Task, Run] {
  const [state, task, run] = running();
  db.run(state.db(), "UPDATE tasks SET kind='review' WHERE id=?1", task.id);
  return [state, reload(state, task.id), run];
}

/** What a restarted server does with the run: its calls are forgotten, and it follows the run again. */
function restart(state: Shared, task: Task) {
  state.perm_waiters.clear();
  state.calls_inflight.clear();
  state.runs.delete(task.id);
  load_active(state);
}

test("the_board_servers_handshake_is_answered_on_the_input", async () => {
  const [state, , run] = running();
  output(state, run, [
    mcp_message("i1", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }),
    mcp_message("i2", { jsonrpc: "2.0", method: "notifications/initialized" }),
    mcp_message("i3", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    mcp_message("i4", { jsonrpc: "2.0", id: 2, method: "ping" }),
    mcp_message("i5", { jsonrpc: "2.0", id: 3, method: "tools/list" }, "other"),
  ]);
  const by_id = new Map((await answered(state, run, 5)).map((r) => [r.request_id, r]));
  const init = by_id.get("i1")!;
  assert.equal(init.subtype, "success");
  assert.deepEqual([init.response.mcp_response.id, init.response.mcp_response.result.serverInfo.name], [0, "huntaway"]);
  assert.equal(init.response.mcp_response.result.protocolVersion, "2025-11-25");
  assert.match(init.response.mcp_response.result.instructions, /Huntaway board/);
  // A notification still gets its control response, which Claude Code waits for.
  assert.deepEqual(by_id.get("i2")!.response, { mcp_response: { jsonrpc: "2.0", id: 0, result: {} } });
  const listed = by_id.get("i3")!.response.mcp_response;
  assert.equal(listed.id, 1);
  const names = listed.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("create_task") && names.includes("wait") && !names.includes("submit_review"), names.join());
  assert.deepEqual(by_id.get("i4")!.response.mcp_response, { jsonrpc: "2.0", id: 2, result: {} });
  // Only the board's server is in process.
  assert.equal(by_id.get("i5")!.response.mcp_response.error.code, -32601);
  assert.equal(db.value<number>(state.db(), "SELECT COUNT(*) FROM mcp_calls"), 0);
  await quiet(state, run, 5);
});

test("a_board_call_on_the_output_knows_its_task_from_its_run", async () => {
  const [state, task, run] = running();
  output(state, run, [tool_call("c1", 4, "get_task", { task_id: task.id })]);
  const [r] = await answered(state, run, 1);
  assert.deepEqual([r.subtype, r.request_id, r.response.mcp_response.jsonrpc, r.response.mcp_response.id], ["success", "c1", "2.0", 4]);
  const [text, error] = said_by(r);
  assert.equal(error, false, text);
  assert.match(text, new RegExp(task.id));
  // Recorded as the board's calls are, with what answering it again takes.
  assert.equal(call_status(state, run, "c1"), "done");
  const args = JSON.parse(db.value<string>(state.db(), "SELECT args FROM mcp_calls WHERE id=?1", control_call_id(run.id, "c1"))!);
  assert.deepEqual(args, { request_id: "c1", rpc_id: 4, arguments: { task_id: task.id } });
  assert.equal(db.value(state.db(), "SELECT task_id FROM mcp_calls WHERE id=?1", control_call_id(run.id, "c1")), task.id);

  // An error is the tool's result, as the HTTP server has it.
  output(state, run, [tool_call("c2", 5, "get_task", { task: task.id })]);
  const [text2, error2] = said_by((await answered(state, run, 2))[1]);
  assert.ok(error2 && text2.startsWith("Error: get_task has no argument \"task\""), text2);
});

test("a_reviewers_board_server_has_the_reviewers_tools_only", async () => {
  const [state, task, run] = reviewing();
  output(state, run, [mcp_message("l1", { jsonrpc: "2.0", id: 1, method: "tools/list" })]);
  const names = (await answered(state, run, 1))[0].response.mcp_response.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("submit_review") && names.includes("get_task") && !names.includes("create_task") && !names.includes("update_task"), names.join());
  // Whatever it calls.
  output(state, run, [tool_call("c1", 2, "update_task", { task_id: task.id, title: "changed" })]);
  const [text, error] = said_by((await answered(state, run, 2))[1]);
  assert.ok(error && /isn't available to reviewers/.test(text), text);
  assert.equal(reload(state, task.id).title, "t");
});

test("a_board_call_read_again_runs_and_is_answered_once", async () => {
  const [state, task, run] = running();
  const line = `${JSON.stringify(tool_call("c1", 7, "update_task", { task_id: task.id, title: "once" }))}\n`;
  on_output(state, run.id, 0, line);
  await answered(state, run, 1);
  assert.equal(reload(state, task.id).title, "once");
  // The server stopped before it saved how far it read: the line comes again, after the user renamed the task.
  state.update_task(task.id, [["title", "renamed"]]);
  db.run(state.db(), "UPDATE runs SET out_offset=0 WHERE id=?1", run.id);
  on_output(state, run.id, 0, line);
  await quiet(state, run, 1);
  assert.equal(reload(state, task.id).title, "renamed");
});

test("after_a_restart_a_board_call_cut_short_is_answered", async () => {
  const [state, task, run] = running();
  // What a server that stopped mid-call left: calls recorded as executing, past the run's saved offset.
  const left = (request_id: string, rpc_id: number, tool: string, args: any) =>
    db.run(
      state.db(),
      "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,created_at) VALUES (?1,?2,?3,?4,?5,'executing','2026-11-06T00:00:00Z')",
      control_call_id(run.id, request_id),
      run.id,
      task.id,
      tool,
      JSON.stringify({ request_id, rpc_id, arguments: args }),
    );
  left("c1", 11, "get_task", { task_id: task.id });
  left("c2", 12, "update_task", { task_id: task.id, title: "twice?" });
  restart(state, task);
  const by_id = new Map((await answered(state, run, 2)).map((r) => [r.request_id, r]));
  // One that only reads runs again; one that may have taken effect says so, rather than run again or not answer.
  assert.equal(by_id.get("c1")!.response.mcp_response.id, 11);
  assert.match(said_by(by_id.get("c1")!)[0], new RegExp(task.id));
  assert.equal(by_id.get("c2")!.response.mcp_response.id, 12);
  const [text, error] = said_by(by_id.get("c2")!);
  assert.ok(error && /was interrupted/.test(text), text);
  assert.equal(reload(state, task.id).title, "t");
  assert.deepEqual([call_status(state, run, "c1"), call_status(state, run, "c2")], ["done", "done"]);
  // Another restart answers neither again.
  restart(state, task);
  await quiet(state, run, 2);
});

test("a_wait_carries_on_over_a_restart", async () => {
  const [state, task, run] = running();
  // A wait that was going when the server stopped, with its deadline.
  const call_id = control_call_id(run.id, "w1");
  db.run(
    state.db(),
    "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,created_at) VALUES (?1,?2,?3,'wait',?4,'executing','2026-11-06T00:00:00Z')",
    call_id,
    run.id,
    task.id,
    JSON.stringify({ request_id: "w1", rpc_id: 21, arguments: { seconds: 20, reason: "CI" } }),
  );
  const until = new Date(Date.now() + 600).toISOString();
  state.update_task(task.id, [["agent_wait", { reason: "CI", since: new Date().toISOString(), until, tasks: [], call_id, run_id: run.id }]]);
  restart(state, task);
  // It ends when it would have, not 20 seconds after the restart.
  await quiet(state, run, 0);
  assert.equal(reload(state, task.id).agent_wait?.call_id, call_id);
  const [r] = await answered(state, run, 1);
  assert.equal(r.response.mcp_response.id, 21);
  const [text, error] = said_by(r);
  assert.ok(!error && /timeout/i.test(text), text);
  assert.equal(reload(state, task.id).agent_wait, null);
  await quiet(state, run, 1);
});

/** Claude Code gives up on the board call it sent with JSON-RPC id `rpc_id`, as it does: a notification to the server. */
const cancelled = (request_id: string, rpc_id: number | string) =>
  mcp_message(request_id, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: rpc_id, reason: "AbortError: remote-cancel" } });

test("a_board_call_claude_cancels_ends_unanswered", async () => {
  const [state, task, run] = running();
  output(state, run, [tool_call("w1", 3, "wait", { seconds: 20, reason: "CI" })]);
  for (let i = 0; i < 100 && !reload(state, task.id).agent_wait; i++) await sleep(5);
  assert.equal(reload(state, task.id).agent_wait?.call_id, control_call_id(run.id, "w1"));
  // A cancel of another id (or the same id as a string) leaves it waiting; the notifications themselves are answered.
  output(state, run, [cancelled("n1", 4), cancelled("n2", "3")]);
  assert.equal(reload(state, task.id).agent_wait?.call_id, control_call_id(run.id, "w1"));
  assert.deepEqual((await answered(state, run, 2)).map((r) => [r.request_id, r.response.mcp_response.result]), [["n1", {}], ["n2", {}]]);
  output(state, run, [cancelled("n3", 3)]);
  assert.equal(reload(state, task.id).agent_wait, null);
  await answered(state, run, 3);
  // The wait itself isn't answered.
  await quiet(state, run, 3);
  for (let i = 0; i < 200 && call_status(state, run, "w1") !== "done"; i++) await sleep(5);
  assert.equal(call_status(state, run, "w1"), "done");
  await quiet(state, run, 3);
});

test("an_approval_claude_cancels_can_no_longer_be_given", async () => {
  const [state, task, run] = running();
  const project_id = "kiwicd";
  db.insert_project(state.db(), {
    id: project_id,
    profile_id: task.profile_id,
    name: project_id,
    key: "KIW",
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
  });
  db.run(state.db(), "UPDATE tasks SET project_id=?1, number=1 WHERE id=?2", project_id, task.id);
  const doomed = db.insert_task(state.db(), { profile_id: task.profile_id, project_id, kind: "task", title: "Doomed", description: "", status: "backlog", use_worktree: false });
  output(state, run, [tool_call("d1", 5, "delete_task", { task_id: doomed.id, reason: "A duplicate" })]);
  for (let i = 0; i < 200 && request_of(state, run, "d1")?.status !== "pending"; i++) await sleep(5);
  assert.equal(request_of(state, run, "d1")?.status, "pending");
  output(state, run, [cancelled("n1", 5)]);
  assert.equal(request_of(state, run, "d1")!.status, "expired");
  assert.throws(() => permissions.decide(state, request_of(state, run, "d1")!.id, true, false, null), /no longer pending/);
  for (let i = 0; i < 200 && call_status(state, run, "d1") !== "done"; i++) await sleep(5);
  assert.notEqual(db.get_task(state.db(), doomed.id), null);
  // Only the notification was answered.
  assert.deepEqual((await answered(state, run, 1)).map((r) => r.request_id), ["n1"]);
  await quiet(state, run, 1);
});

test("claude_codes_answer_to_the_initialize_isnt_taken_for_another", async () => {
  const [state, task, run] = running();
  output(state, run, [{ type: "control_response", response: { subtype: "success", request_id: `huntaway-init-${run.id}`, response: { commands: [] } } }]);
  assert.equal(testing.messages(state.db(), task.id).length, 0);
  // Refused, the run goes on without the board's tools, and the thread says so.
  output(state, run, [{ type: "control_response", response: { subtype: "error", request_id: `huntaway-init-${run.id}`, error: "unknown subtype" } }]);
  const said = testing.messages(state.db(), task.id).filter((m) => m.kind === "event").map((m) => m.data.text);
  assert.equal(said.length, 1);
  assert.match(said[0], /didn't take the board's tools \(unknown subtype\)/);
});

test("the_initialize_registers_the_board_server_with_its_handshake", () => {
  const line = JSON.parse(initialize_line("run1", false));
  assert.deepEqual([line.type, line.request_id, line.request.subtype, line.request.sdkMcpServers], ["control_request", "huntaway-init-run1", "initialize", ["huntaway"]]);
  assert.deepEqual(line.request.sdkMcpServerConfigs.huntaway, { timeout: 86_400_000, disableAutoBackground: true });
  const manifest = line.request.sdkMcpServerManifests.huntaway;
  assert.equal(manifest.initializeResult.protocolVersion, MCP_PROTOCOL);
  const names = (review: boolean) => JSON.parse(initialize_line("r", review)).request.sdkMcpServerManifests.huntaway.toolsListResult.tools.map((t: any) => t.name);
  assert.ok(names(false).includes("create_task") && !names(false).includes("submit_review"));
  assert.ok(names(true).includes("submit_review") && !names(true).includes("create_task"));
});

const background = (n: number) => ({ type: "system", subtype: "background_tasks_changed", tasks: Array.from({ length: n }, (_, i) => ({ id: `b${i}` })) });
const result = () => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1 });
const said = (text: string) => ({
  type: "assistant",
  uuid: `u-${text}`,
  parent_tool_use_id: null,
  message: { id: `m-${text}`, role: "assistant", content: [{ type: "text", text }] },
});
const input_closed = (state: Shared, run: Run) => existsSync(join(runs.run_dir(state, run.id), "input.closed"));

test("the_turn_on_background_tasks_outcome_can_still_ask", async () => {
  const [state, task, run] = running();
  output(state, run, [background(1), result()]);
  // They end between turns: Claude Code takes a turn on their outcome, and its prompts need the input.
  output(state, run, [background(0)]);
  assert.ok(!input_closed(state, run));
  output(state, run, [said("The build finished; committing."), can_use_tool("r1", "Bash", { command: "git commit" })]);
  assert.equal(reload(state, task.id).status, "needs_attention");
  // However long the user takes.
  await sleep(BACKGROUND_GRACE * 1.5);
  assert.ok(!input_closed(state, run));
  permissions.decide(state, request_of(state, run, "r1")!.id, true, false, null);
  await answered(state, run, 1);
  // That turn's end closes it, as any turn's without background tasks does.
  output(state, run, [result()]);
  assert.ok(input_closed(state, run));
});

test("without_a_turn_on_background_tasks_outcome_the_input_is_closed", async () => {
  const [state, , run] = running();
  output(state, run, [background(1), result(), background(0)]);
  await sleep(BACKGROUND_GRACE / 2);
  assert.ok(!input_closed(state, run));
  await sleep(BACKGROUND_GRACE);
  assert.ok(input_closed(state, run));
});

test("after_a_restart_the_turn_on_background_tasks_outcome_can_still_ask", async () => {
  const [state, task, run] = running();
  output(state, run, [background(1), result(), background(0)]);
  state.runs.delete(task.id);
  load_active(state);
  assert.ok(!input_closed(state, run));
  output(state, run, [said("Done in the background.")]);
  await sleep(BACKGROUND_GRACE * 1.5);
  assert.ok(!input_closed(state, run));
  output(state, run, [result()]);
  assert.ok(input_closed(state, run));
});

test("a_run_that_asks_through_the_helper_closes_its_input_when_background_tasks_end", () => {
  const [state, , run] = running();
  writeFileSync(join(runs.run_dir(state, run.id), "run.json"), JSON.stringify({ format: 2 }));
  output(state, run, [background(1), result(), background(0)]);
  assert.ok(input_closed(state, run));
});

const init = () => ({ type: "system", subtype: "init", session_id: "s1", tools: [] });

test("background_tasks_that_end_in_a_turn_leave_the_input_open_for_the_turn_on_their_outcome", async () => {
  const [state, task, run] = running();
  output(state, run, [background(1), said("Started it; writing my reply."), background(0), result()]);
  assert.ok(!input_closed(state, run));
  // Claude Code takes its turn on their outcome right after, and it asks.
  output(state, run, [init(), said("The build finished; committing."), can_use_tool("r1", "Bash", { command: "git commit" })]);
  assert.equal(reload(state, task.id).status, "needs_attention");
  await sleep(FOLLOW_UP_GRACE * 2.5);
  assert.ok(!input_closed(state, run));
  permissions.decide(state, request_of(state, run, "r1")!.id, true, false, null);
  await answered(state, run, 1);
  output(state, run, [result()]);
  assert.ok(input_closed(state, run));
  assert.ok(!runs.background_ended(state, run.id));
});

test("background_tasks_that_end_in_a_turn_taken_in_by_it_close_the_input_after_a_while", async () => {
  const [state, , run] = running();
  output(state, run, [background(1), said("Started it."), background(0), said("It finished: all good."), result()]);
  await sleep(FOLLOW_UP_GRACE / 2);
  assert.ok(!input_closed(state, run));
  await sleep(FOLLOW_UP_GRACE);
  assert.ok(input_closed(state, run));
});

test("background_tasks_that_end_in_a_turn_are_remembered_over_a_restart", async () => {
  const [state, task, run] = running();
  output(state, run, [background(1), said("Started it."), background(0)]);
  state.runs.delete(task.id);
  load_active(state);
  output(state, run, [result()]);
  assert.ok(!input_closed(state, run));
  output(state, run, [init(), said("On its outcome.")]);
  await sleep(FOLLOW_UP_GRACE * 2.5);
  assert.ok(!input_closed(state, run));
  output(state, run, [result()]);
  assert.ok(input_closed(state, run));
});

test("a_task_started_again_in_the_turn_forgets_that_the_others_ended", () => {
  const [state, , run] = running();
  output(state, run, [background(1), said("a"), background(0), background(1), result()]);
  assert.ok(!runs.background_ended(state, run.id));
  assert.ok(!input_closed(state, run));
});

test("a_run_that_asks_through_the_helper_closes_at_the_end_of_a_turn_its_background_tasks_ended_in", () => {
  const [state, , run] = running();
  writeFileSync(join(runs.run_dir(state, run.id), "run.json"), JSON.stringify({ format: 2 }));
  output(state, run, [background(1), said("a"), background(0), result()]);
  assert.ok(input_closed(state, run));
});
