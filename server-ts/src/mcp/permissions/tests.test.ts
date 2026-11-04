// Port of server/src/mcp/permissions/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import * as runner from "../../agent/runner.ts";
import * as runs from "../../agent/runs.ts";
import { new_id, now, sleep } from "../../util.ts";
import {
  ASK_USER,
  CODEX_QUESTIONS,
  DONT_ASK_DENIAL,
  EXIT_PLAN,
  EXPIRED,
  answer,
  apply_mode_to_pending,
  decide,
  expire_for_task,
  pending,
  prompt,
  reason,
  type Reply,
} from "../permissions.ts";

/**
 * A task (in the profile's default config, or `config`'s), and a run of it that's going (so a message sent to it is
 * queued for it, as no agent reads its input).
 */
function running_task(s: Shared, config: string | null): [Task, db.Run] {
  const ids = config ? [config] : [];
  const profile = db.insert_profile(s.db(), `p${new_id()}`, ids, null);
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
    claude_config_id: config,
  };
  const task0 = db.insert_task(s.db(), t);
  const run = db.insert_run(s.db(), task0.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task0.id, { run_id: run.id, cancel: null });
  const task = s.update_task(task0.id, [["running", true]])!;
  return [task, run];
}

/**
 * Raise a prompt for `tool` from `task` (as MCP call `call_id`) and wait until it's asked. Returns its request id and
 * what the agent is told once it's answered.
 */
async function asked(s: Shared, task: Task, call_id: string, tool: string, input: any): Promise<[string, Promise<any>]> {
  const told = prompt(s, task, call_id, tool, input, null);
  told.catch(() => {});
  for (;;) {
    const id = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1", call_id);
    if (id !== undefined) return [id, told];
    await sleep(5);
  }
}

function prompt_message(s: Shared, id: string): any {
  const mid = db.value<number>(s.db(), "SELECT message_id FROM permission_requests WHERE id=?1", id);
  return JSON.parse(db.value<string>(s.db(), "SELECT data FROM messages WHERE id=?1", mid)!);
}

function two_questions(): any {
  return {
    questions: [
      { question: "Which season?", header: "Season", multiSelect: false, options: [{ label: "Summer", description: "Warm" }, { label: "Winter" }] },
      { question: "Which pets?", header: "Pets", multiSelect: true, options: [{ label: "Cats" }, { label: "Dogs" }, { label: "Birds" }] },
    ],
  };
}

function answers(a: string[][]): Reply {
  return { answers: a };
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

const status = (s: Shared, id: string) => db.value<string>(s.db(), "SELECT status FROM permission_requests WHERE id=?1", id);

test("answers_to_claudes_questions_go_back_as_its_tool_takes_them", async () => {
  const s = testing.state();
  const [task] = running_task(s, null);
  const input = two_questions();
  const [id, told] = await asked(s, task, "c1", ASK_USER, input);
  // The task says what it's waiting for: a question, not a permission.
  let t = db.get_task(s.db(), task.id)!;
  assert.deepEqual([t.status, t.attention_reason], ["needs_attention", "Which season? (and 1 more question)"]);
  // Answers are checked against the questions.
  assert.equal(status_of(() => answer(s, id, true, false, null, answers([["Summer"]]))), 400);
  assert.equal(status_of(() => answer(s, id, true, false, null, answers([["Summer", "Winter"], []]))), 400);

  assert.equal(answer(s, id, true, false, null, answers([[" Summer "], ["Cats", "Birds", "a lizard"]])), "allowed");
  const updated = { ...input, answers: { "Which season?": "Summer", "Which pets?": "Cats, Birds, a lizard" } };
  assert.deepEqual(await told, { behavior: "allow", updatedInput: updated });
  const shown = prompt_message(s, id);
  assert.deepEqual([shown.status, shown.answers], ["allowed", [["Summer"], ["Cats", "Birds", "a lizard"]]]);
  t = db.get_task(s.db(), task.id)!;
  assert.deepEqual([t.status, t.attention_reason], ["in_progress", null]);
  // Answers to a question the agent is waiting for are a prompt too; a permission decision isn't.
  assert.ok(t.now_at != null);
  // Not as an always-allowed tool.
  assert.equal(t.auto_allow.length, 0);
});

test("answers_to_codexs_questions_go_back_by_question_id", async () => {
  const s = testing.state();
  const codex = db.insert_claude_config(s.db(), "Codex", "", "codex");
  const [task] = running_task(s, codex.id);
  const input = {
    questions: [
      { id: "name", question: "Which name?", options: [{ label: "a.txt", description: "" }], isOther: true, isSecret: false },
      { id: "token", question: "Your token?", options: [], isOther: true, isSecret: true },
      { id: "skip", question: "Anything else?", options: [{ label: "No", description: "" }], isOther: false, isSecret: false },
    ],
  };
  const [id, told] = await asked(s, task, "c1", CODEX_QUESTIONS, input);
  // The thread says it's Codex asking.
  assert.equal(prompt_message(s, id).agent, "codex");
  answer(s, id, true, true, null, answers([["b.txt"], ["s3cret"], []]));
  const v = await told;
  assert.deepEqual(v.updatedInput.answers, { name: { answers: ["b.txt"] }, token: { answers: ["s3cret"] } });
  // The thread doesn't show a secret.
  assert.deepEqual(prompt_message(s, id).answers, [["b.txt"], ["(hidden)"], []]);
});

test("questions_are_asked_whatever_the_threads_mode_unless_it_asks_nothing", async () => {
  const s = testing.state();
  const [task0] = running_task(s, null);
  const task = s.update_task(task0.id, [["permission_mode", "bypassPermissions"], ["auto_allow", '["AskUserQuestion"]']])!;
  // Bypass allows a tool call, but a question is still the user's to answer.
  assert.equal((await prompt(s, task, "b", "Bash", { command: "ls" }, null)).behavior, "allow");
  const [id, told] = await asked(s, task, "q", ASK_USER, two_questions());
  const [bash, bash_told] = await asked(s, s.update_task(task.id, [["permission_mode", "default"]])!, "b2", "Bash", {});
  // Switching to Bypass settles the tool call, not the question.
  let t = s.update_task(task.id, [["permission_mode", "bypassPermissions"]])!;
  apply_mode_to_pending(s, t);
  assert.equal((await bash_told).behavior, "allow");
  assert.deepEqual([status(s, bash), status(s, id)], ["allowed", "pending"]);
  // Don't ask denies it, as it does every prompt.
  t = s.update_task(task.id, [["permission_mode", "dontAsk"]])!;
  apply_mode_to_pending(s, t);
  assert.deepEqual(await told, { behavior: "deny", message: DONT_ASK_DENIAL });
  assert.equal((await prompt(s, t, "q2", ASK_USER, two_questions(), null)).behavior, "deny");
});

test("only_the_first_answer_counts", async () => {
  const s = testing.state();
  const [task] = running_task(s, null);
  const [id, told] = await asked(s, task, "c1", ASK_USER, two_questions());
  // Two tabs answering at once (one after the other here: one thread).
  const results = [["Summer"], ["Winter"]].map((season) => {
    try {
      return { ok: answer(s, id, true, false, null, answers([season, []])) };
    } catch (e) {
      return { err: e };
    }
  });
  assert.equal(results.filter((r) => "ok" in r).length, 1);
  const refused = results.find((r) => "err" in r) as { err: any };
  assert.equal(refused.err.status, 409);
  const given = (await told).updatedInput.answers["Which season?"];
  assert.equal(prompt_message(s, id).answers[0][0], given);
  // Nor can it be denied after.
  assert.throws(() => decide(s, id, false, false, null));
});

test("an_approved_plan_carries_on_in_the_mode_picked", async () => {
  const s = testing.state();
  const [task0] = running_task(s, null);
  let task = s.update_task(task0.id, [["permission_mode", "plan"]])!;
  const plan = { plan: "# Plan: add a cache\n\n1. Do it", planFilePath: "/p.md" };
  let [id, told] = await asked(s, task, "p1", EXIT_PLAN, plan);
  assert.equal(db.get_task(s.db(), task.id)!.attention_reason, "Plan ready for approval: add a cache");
  // Sent back with feedback.
  assert.equal(answer(s, id, false, false, null, { feedback: " Add tests too. " }), "denied");
  const denied = await told;
  assert.equal(denied.behavior, "deny");
  assert.ok(denied.message.endsWith("Their feedback:\n\nAdd tests too."), JSON.stringify(denied));
  assert.equal(prompt_message(s, id).feedback, "Add tests too.");
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "plan");

  // Approved, into Accept edits: the agent's Claude Code switches to it too.
  [id, told] = await asked(s, task, "p2", EXIT_PLAN, plan);
  assert.equal(status_of(() => answer(s, id, true, false, null, { mode: "plan" })), 400);
  answer(s, id, true, false, null, { mode: "acceptEdits" });
  assert.deepEqual(await told, {
    behavior: "allow",
    updatedInput: plan,
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "acceptEdits");
  assert.equal(prompt_message(s, id).mode, "acceptEdits");

  // Into the thread's default (Ask): its own mode is cleared, and Claude Code goes to Ask by itself.
  task = s.update_task(task.id, [["permission_mode", "plan"]])!;
  [id, told] = await asked(s, task, "p3", EXIT_PLAN, plan);
  answer(s, id, true, false, null, { mode: "default" });
  assert.deepEqual(await told, { behavior: "allow", updatedInput: plan });
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, null);

  // From a UI that doesn't pick: out of Plan, as before.
  task = s.update_task(task.id, [["permission_mode", "plan"]])!;
  [id, told] = await asked(s, task, "p4", EXIT_PLAN, plan);
  decide(s, id, true, false, null);
  assert.equal((await told).behavior, "allow");
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, null);
});

test("a_question_or_plan_whose_run_ended_is_answered_by_message", async () => {
  const s = testing.state();
  const [task, run] = running_task(s, null);
  const [id, told] = await asked(s, task, "c1", ASK_USER, two_questions());
  const [bash] = await asked(s, task, "c2", "Bash", { command: "ls" });
  const [plan] = await asked(s, task, "c3", EXIT_PLAN, { plan: "Do it" });
  // Its run ended (see runner::finish).
  expire_for_task(s, task.id);
  assert.deepEqual(await told, { behavior: "deny", message: EXPIRED });
  // A tool call can't be allowed once its run has ended.
  assert.equal(status_of(() => decide(s, bash, true, false, null)), 409);

  // Without a run to take it (and no agents here to start one), the answer isn't sent, and can be given again.
  s.runs.delete(task.id);
  assert.throws(() => answer(s, id, true, false, null, answers([["Winter"], ["Dogs"]])));
  assert.equal(prompt_message(s, id).status, "expired");

  assert.equal(db.get_task(s.db(), task.id)!.now_at, null, "not sent, so not a prompt");

  s.runs.set(task.id, { run_id: run.id, cancel: null });
  assert.equal(answer(s, id, true, false, null, answers([["Winter"], ["Dogs"]])), "allowed");
  // The answers are the user's prompt: it puts the task in now.
  assert.ok(db.get_task(s.db(), task.id)!.now_at != null);
  const queued = db.get_task(s.db(), task.id)!.queued_message;
  assert.equal(queued, "My answers to the questions you asked:\n\n- Which season?\n  Winter\n- Which pets?\n  Dogs");
  const shown = prompt_message(s, id);
  assert.deepEqual([shown.status, shown.late, shown.answers], ["allowed", true, [["Winter"], ["Dogs"]]]);
  assert.throws(() => answer(s, id, true, false, null, answers([["Summer"], []])));

  // The plan, approved: out of Plan mode, with a message to carry on.
  s.update_task(task.id, [["permission_mode", "plan"], ["queued_message", null]]);
  answer(s, id_of(s, "c3"), true, false, null, { mode: "acceptEdits" });
  const t = db.get_task(s.db(), task.id)!;
  assert.deepEqual([t.permission_mode, t.queued_message], ["acceptEdits", "Your plan is approved: go ahead and implement it."]);
  assert.equal(prompt_message(s, plan).status, "allowed");
});

test("a_question_or_plan_the_conversation_has_moved_past_isnt_answered", async () => {
  const s = testing.state();
  const [task] = running_task(s, null);
  s.update_task(task.id, [["permission_mode", "plan"]]);
  const [question] = await asked(s, task, "c1", ASK_USER, two_questions());
  const [plan] = await asked(s, task, "c2", EXIT_PLAN, { plan: "Do it" });
  expire_for_task(s, task.id);
  // The user carries on in the thread (here, steering the next run).
  const m = db.insert_message(s.db(), task.id, "user", { text: "Never mind, do this instead" });
  s.emit_message(m);

  assert.equal(status_of(() => answer(s, question, true, false, null, answers([["Summer"], []]))), 409);
  assert.equal(status_of(() => answer(s, plan, true, false, null, { mode: "acceptEdits" })), 409);
  assert.throws(() => answer(s, plan, false, false, null, { feedback: "More" }));
  // Nothing was sent, and the thread's still planning.
  const t = db.get_task(s.db(), task.id)!;
  assert.deepEqual([t.queued_message, t.permission_mode], [null, "plan"]);
  assert.deepEqual([prompt_message(s, question).status, prompt_message(s, plan).status], ["expired", "expired"]);
});

test("approving_a_plan_in_the_threads_own_mode_keeps_it", async () => {
  const s = testing.state();
  const [task0] = running_task(s, null);
  // Its own mode is Accept edits (the host's default is Ask), and the agent went into plan mode by itself.
  let task = s.update_task(task0.id, [["permission_mode", "acceptEdits"]])!;
  const plan = { plan: "Do it" };
  let [id, told] = await asked(s, task, "p1", EXIT_PLAN, plan);
  answer(s, id, true, false, null, { mode: "acceptEdits" });
  assert.deepEqual((await told).updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "acceptEdits");
  // Approved without a pick, as before: it's left alone too.
  [id] = await asked(s, task, "p2", EXIT_PLAN, plan);
  decide(s, id, true, false, null);
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "acceptEdits");
  // Picking the default is a change back to it.
  [id] = await asked(s, task, "p3", EXIT_PLAN, plan);
  answer(s, id, true, false, null, { mode: "default" });
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, null);
  // A thread set to Ask itself stays so (rather than following the host's default from now on).
  task = s.update_task(task.id, [["permission_mode", "default"]])!;
  [id] = await asked(s, task, "p4", EXIT_PLAN, plan);
  answer(s, id, true, false, null, { mode: "default" });
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "default");
});

test("a_late_approval_leaves_plan_mode_before_its_message_starts_a_run", async () => {
  const s = testing.state();
  const [task, run] = running_task(s, null);
  s.update_task(task.id, [["permission_mode", "plan"]]);
  const [id] = await asked(s, task, "p1", EXIT_PLAN, { plan: "Do it" });
  s.runs.delete(task.id);
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  expire_for_task(s, task.id);
  s.update_task(task.id, [["running", false]]);

  // No agent can start: the approval isn't taken, and the thread's still planning.
  const approve = (): Reply => ({ mode: "auto" });
  assert.throws(() => answer(s, id, true, false, null, approve()));
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "plan");
  assert.equal(prompt_message(s, id).status, "expired");

  // One that starts runs with the mode picked, from the run the approval starts.
  (runs as any).TEST_CAN_RUN.set(true);
  let mode: string | null | undefined;
  testing.when("run:started", () => {
    mode = db.get_task(s.db(), task.id)!.permission_mode;
  });
  try {
    answer(s, id, true, false, null, approve());
  } finally {
    (runs as any).TEST_CAN_RUN.set(false);
  }
  assert.equal(mode, "auto");
  runner.stop(s, task.id);
});

function id_of(s: Shared, call_id: string): string {
  return db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1", call_id)!;
}

test("a_prompt_from_before_answers_were_taken_can_be_answered", async () => {
  const s = testing.state();
  const [task] = running_task(s, null);
  // As an older build raised it: no agent in its message, and the MCP call retried after the upgrade finds it.
  const input = two_questions();
  const data = { tool_name: ASK_USER, input, tool_use_id: null, request_id: "old", status: "pending" };
  const msg = s.add_message(task.id, "permission", data);
  db.run(
    s.db(),
    "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES ('old',?1,?2,?3,?4,'pending',?5,'c1')",
    task.id,
    msg.id,
    ASK_USER,
    JSON.stringify(input),
    now(),
  );
  const [id, told] = await asked(s, task, "c1", ASK_USER, input);
  assert.equal(id, "old");
  answer(s, id, true, false, null, answers([["Summer"], ["Cats"]]));
  assert.deepEqual((await told).updatedInput.answers, { "Which season?": "Summer", "Which pets?": "Cats" });
});

test("says_what_a_question_or_plan_waits_for", () => {
  assert.equal(reason(ASK_USER, { questions: [{ question: "Which\n  one?" }] }), "Which one?");
  assert.equal(reason(CODEX_QUESTIONS, { questions: [{ question: "A?" }, { question: "B?" }, { question: "C?" }] }), "A? (and 2 more questions)");
  assert.equal(reason(ASK_USER, {}), "The agent has questions for you");
  assert.equal(reason(EXIT_PLAN, { plan: "\n## Plan: Add a cache\nSteps" }), "Plan ready for approval: Add a cache");
  assert.equal(reason(EXIT_PLAN, { plan: "Just do it" }), "Plan ready for approval");
  assert.equal(reason("Bash", {}), "Approve Bash?");
});

test("lists_pending_prompts", () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const task = (title: string) =>
    db.insert_task(s.db(), {
      profile_id: profile.id,
      project_id: null,
      kind: "scratch",
      title,
      description: "",
      status: "todo",
      use_worktree: false,
      model: null,
      effort: null,
      claude_config_id: null,
    }).id;
  const [a, b] = [task("a"), task("b")];
  const add = (id: string, task: string, input: string, status: string) => {
    db.run(
      s.db(),
      "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at) VALUES (?1,?2,0,'Bash',?3,?4,?5)",
      id,
      task,
      input,
      status,
      now(),
    );
  };
  add("r1", a, '{"command":"ls"}', "pending");
  add("r2", b, "not json", "pending");
  add("r3", a, "{}", "allowed");

  const ids = (v: any[]) => v.map((r) => r.id);
  assert.deepEqual(ids(pending(s, null)), ["r1", "r2"]);
  const only_a = pending(s, a);
  assert.deepEqual(ids(only_a), ["r1"]);
  assert.equal(only_a[0].input.command, "ls");
  assert.equal(only_a[0].task_id, a);
  assert.equal(pending(s, b)[0].input, "not json");
});
