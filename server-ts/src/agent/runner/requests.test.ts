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
import { BACKGROUND_GRACE, finish, load_active, on_output } from "../runner.ts";
import { control_call_id } from "./requests.ts";

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

const message_of = (state: Shared, id: number) => JSON.parse(db.value<string>(state.db(), "SELECT data FROM messages WHERE id=?1", id)!);

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
  output(state, run, [{ type: "control_request", request_id: "m1", request: { subtype: "mcp_message", server_name: "x", message: {} } }]);
  const [r] = await answered(state, run, 1);
  assert.equal(r.subtype, "error");
  assert.equal(r.request_id, "m1");
  assert.equal(db.value<number>(state.db(), "SELECT COUNT(*) FROM permission_requests"), 0);
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
