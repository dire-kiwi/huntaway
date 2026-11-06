// Port of the tests in server/src/mcp/questions.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import { answer, card, replied, type Answer } from "./questions.ts";
import { handle_mcp } from "./tools.ts";
import * as permissions from "./permissions.ts";

/** A task with a run that's going (a message sent to it is queued for it, as no agent reads its input). */
function running_task(s: Shared): [Task, db.Run] {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const t = {
    profile_id: profile.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  };
  const task = db.insert_task(s.db(), t);
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  return [task, run];
}

function ask_with(s: Shared, run: db.Run, call_id: string, args: any): Promise<any> {
  return handle_mcp(s, { run_id: run.id, call_id, tool: "request_user_input", args, task_fields: true });
}

function questions(s: Shared, task_id: string): db.Message[] {
  return testing.messages(s.db(), task_id).filter((m) => m.kind === "question");
}

function pick(choices: string[], text: string | null): Answer {
  return { choices, text };
}

/** The status of the ApiError `f` throws. */
function status_of(f: () => unknown): number {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof ApiError, String(e));
    return e.status;
  }
  assert.fail("it didn't fail");
}

test("checks_what_the_agent_asks", () => {
  assert.throws(() => card({ question: " " }));
  const c = card({ question: "Which?", options: ["A", { label: " B ", description: " the second " }, { label: "C", description: "" }] });
  assert.deepEqual(c, {
    question: "Which?",
    options: [{ label: "A" }, { label: "B", description: "the second" }, { label: "C" }],
    multi_select: false,
    allow_other: true,
  });
  assert.throws(() => card({ question: "Which?", options: [{ description: "no label" }] }));
  assert.throws(() => card({ question: "Which?", options: ["A", "A"] }));
  assert.throws(() => card({ question: "Which?", options: Array.from({ length: 10 }, (_, i) => String(i)) }));
  assert.throws(() => card({ question: "Which?", options: "A, B" }));
  assert.throws(() => card({ question: "Which?", multi_select: "yes" }));
  const c2 = card({ question: "Which?", multi_select: true, allow_other: false });
  assert.deepEqual([c2.multi_select, c2.allow_other, c2.options], [true, false, []]);
});

test("a_question_with_options_is_answered_from_its_card", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  const args = { question: "Which colour?", options: [{ label: "Red", description: "Bold" }, { label: "Green" }] };
  const v = await ask_with(s, run, "c1", args);
  assert.ok(v.note.includes("options"), JSON.stringify(v));
  // Asked again after a restart: still one card.
  db.run(s.db(), "UPDATE mcp_calls SET status='executing' WHERE id='c1'");
  await ask_with(s, run, "c1", args);
  const asked = questions(s, task.id);
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].data.status, asked[0].data.call_id], ["pending", "c1"]);
  assert.equal(db.get_run(s.db(), run.id)!.attention, "Which colour?");
  const id = asked[0].id;

  assert.equal(status_of(() => answer(s, task.id, id, pick(["Blue"], null))), 400);
  assert.equal(status_of(() => answer(s, task.id, id, pick(["Red", "Green"], null))), 400);
  assert.equal(status_of(() => answer(s, task.id, id, pick(["Red"], "and blue"))), 400);
  assert.equal(status_of(() => answer(s, task.id, id, pick([], "  "))), 400);
  // Not another thread's.
  assert.equal(status_of(() => answer(s, "other", id, pick(["Red"], null))), 404);

  const t = answer(s, task.id, id, pick(["Red"], null));
  assert.equal(t.queued_message, "> Which colour?\n\nRed");
  // The answer is the user's prompt: it puts the task in now.
  assert.ok(t.now_at != null && db.get_task(s.db(), task.id)!.now_at != null);
  const data = questions(s, task.id)[0].data;
  assert.deepEqual([data.status, data.answer], ["answered", { choices: ["Red"], text: null }]);
  // A second answer (another tab's) isn't sent.
  assert.equal(status_of(() => answer(s, task.id, id, pick(["Green"], null))), 409);
  assert.equal(db.get_task(s.db(), task.id)!.queued_message, "> Which colour?\n\nRed");
});

test("several_answers_or_ones_own", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  await ask_with(s, run, "c1", { question: "Which?", options: ["A", "B", "C"], multi_select: true });
  let id = questions(s, task.id)[0].id;
  let t = answer(s, task.id, id, pick(["C", "A", "A"], "and D,\nwith E"));
  assert.equal(t.queued_message, "> Which?\n\n- C\n- A\n- and D,\n  with E");

  // Only the options, when it doesn't take an answer of the user's own.
  await ask_with(s, run, "c2", { question: "Pick one", options: ["X"], allow_other: false });
  id = questions(s, task.id)[1].id;
  assert.throws(() => answer(s, task.id, id, pick([], "Y")));
  // Without options, any answer.
  await ask_with(s, run, "c3", { question: "What's the URL?" });
  id = questions(s, task.id)[2].id;
  s.update_task(task.id, [["queued_message", null]]);
  t = answer(s, task.id, id, pick([], "https://example.com"));
  assert.equal(t.queued_message, "> What's the URL?\n\nhttps://example.com");
  // That settles the one it was still waiting on as well.
  assert.deepEqual(
    questions(s, task.id).map((m) => m.data.status),
    ["answered", "replied", "answered"],
  );
});

test("stays_answerable_after_the_run_and_until_its_answer_is_sent", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  await ask_with(s, run, "c1", { question: "Which?", options: ["A", "B"] });
  const id = questions(s, task.id)[0].id;
  // The run ends (and no agent can start here): the answer can't be sent, so it can be given again.
  s.runs.delete(task.id);
  permissions.expire_for_task(s, task.id);
  assert.throws(() => answer(s, task.id, id, pick(["A"], null)));
  assert.equal(questions(s, task.id)[0].data.status, "pending");
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  answer(s, task.id, id, pick(["B"], null));
});

test("a_question_the_conversation_has_moved_past_isnt_answered", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  await ask_with(s, run, "c1", { question: "Which?", options: ["A", "B"] });
  // A message that doesn't settle it as the user's reply does (the board's own, say).
  db.insert_message(s.db(), task.id, "user", { text: "Merge it", auto: true });
  const id = questions(s, task.id)[0].id;
  assert.equal(status_of(() => answer(s, task.id, id, pick(["A"], null))), 409);
  assert.equal(db.get_task(s.db(), task.id)!.queued_message, null);
});

test("a_reply_in_the_thread_settles_its_questions", async () => {
  const s = testing.state();
  const [task, run] = running_task(s);
  await ask_with(s, run, "c1", { question: "Which?", options: ["A", "B"] });
  replied(s, task.id);
  assert.equal(questions(s, task.id)[0].data.status, "replied");
  assert.equal(status_of(() => answer(s, task.id, questions(s, task.id)[0].id, pick(["A"], null))), 409);
});
