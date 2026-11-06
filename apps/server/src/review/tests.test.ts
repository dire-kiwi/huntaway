// The tests of server/src/review/tests.rs (review.rs's).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { ClaudeConfig, Review, ReviewerRun, Task } from "../db.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as analytics from "../analytics.ts";
import * as tools from "../mcp/tools.ts";
import * as testing from "../testing.ts";
import type { AppState } from "../state.ts";
import { err_str, now, sleep } from "../util.ts";
import {
  LAST_MESSAGE_CHARS,
  REPLIES_CHARS,
  REPLY_CHARS,
  REPLY_CONTEXT_CHARS,
  changed_elsewhere,
  extend,
  finished,
  label,
  prompt,
  rev_parse,
  send_issues,
  set_review,
  start,
  stop,
  submit,
  supersede,
  user_said,
} from "../review.ts";

// As in Rust's tests, there's no ia-shim: this host can't run agents unless a test says it can (runs::TEST_CAN_RUN).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

const NO_REPLIES: db.UserReplies = { replies: [], since: null, earlier: 0 };

const new_task = (profile: string, kind: string): any => ({
  profile_id: profile,
  project_id: null,
  kind,
  title: "t",
  description: "",
  status: "in_review",
  use_worktree: false,
  model: null,
  effort: null,
  claude_config_id: null,
});

/** A task titled `title` with no project, on an in-memory database. */
function plain_task(title: string): Task {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  return db.insert_task(c, { ...new_task(p.id, "task"), title, status: "todo" });
}

const at_in = (text: string) => (s: string) => {
  const i = text.indexOf(s);
  assert.ok(i >= 0, `${JSON.stringify(s)} not in ${text}`);
  return i;
};

test("the_projects_instructions_go_between_where_and_how_to_report", () => {
  const task = plain_task("Fix it");
  const text = prompt("X-1", task, "ia/x-1", "master", "abc", { kind: "branch", own_start: false }, ["the bug"], NO_REPLIES, "Check the docs too.");
  const at = at_in(text);
  assert.ok(at("`pr_view` tool (pr `ia/x-1`)") < at("Check the docs too.") && at("Check the docs too.") < at("call `submit_review` once"));
  assert.ok(at("submit_review") < at("- the bug"));
});

test("what_the_user_decided_goes_before_the_instructions", () => {
  const task = plain_task("Fix it");
  const replies: db.UserReplies = {
    replies: [
      ["Should it be A or B?\nB is faster.", "A, the gap is fine"],
      [null, "thanks"],
    ],
    since: null,
    earlier: 0,
  };
  const text = prompt("X-1", task, "ia/x-1", "master", "abc", { kind: "branch", own_start: false }, [], replies, "Check the docs too.");
  const at = at_in(text);
  assert.ok(at("`pr_view`") < at("decisions they made there stand") && at("decisions they made") < at("Check the docs too."));
  assert.ok(at("The agent:\n\n> Should it be A or B?\n> B is faster.\n\nThe user:\n\n> A, the gap is fine\n") < at("The user:\n\n> thanks"));
  const none = prompt("X-1", task, "ia/x-1", "master", "abc", { kind: "branch", own_start: false }, [], NO_REPLIES, "Check the docs too.");
  assert.ok(!none.includes("decisions they made"));
});

test("what_the_user_said_is_cut_to_the_latest", () => {
  const long = "x".repeat(REPLY_CHARS + 10);
  const said = `${"y".repeat(REPLY_CONTEXT_CHARS)} the question?`;
  let text = user_said([[said, long]], false);
  assert.ok(text.includes(`> ${"x".repeat(REPLY_CHARS)} [...]\n`) && !text.includes(long));
  assert.ok(text.includes("> [...] y") && text.includes("the question?") && !text.includes("y".repeat(REPLY_CONTEXT_CHARS)));
  // The latest messages, as many as fit.
  const many: Array<[string | null, string]> = Array.from({ length: 20 }, (_, i) => [null, `message ${i} ${"z".repeat(REPLY_CHARS - 20)}`]);
  text = user_said(many, false);
  assert.ok(text.length < REPLIES_CHARS + 1000 && text.includes("message 19") && !text.includes("message 0 "));
  const at = at_in(text);
  assert.ok(at("[Earlier messages left out.]") < at("message 18") && at("message 18") < at("message 19"));
  assert.equal(user_said([], false), "");
  // Those the board didn't read are left out too.
  text = user_said(many.slice(18), true);
  assert.ok(text.includes("[Earlier messages left out.]\n\nThe user:\n\n> message 18") && text.includes("message 19"), text);
  assert.ok(!user_said(many.slice(18), false).includes("left out"));
});

test("work_done_elsewhere_is_found_from_the_agents_last_message_and_pr", () => {
  const task = plain_task("Pin images");
  task.pr_url = "https://github.com/o/deploy/pull/4";
  let work: any = { kind: "elsewhere", last_message: "Done in o/deploy#4.\nBoth images build." };
  let text = prompt("X-1", task, "ia/x-1", "master", "abc", work, [], NO_REPLIES, "Check the docs too.");
  const at = at_in(text);
  assert.ok(!text.includes("ia/x-1`)"));
  assert.ok(at("no commits of its own") < at("https://github.com/o/deploy/pull/4") && at("pull/4") < at("`pr_diff` tools with its URL"));
  assert.ok(at("> Done in o/deploy#4.\n> Both images build.") < at("Check the docs too.") && at("Check the docs too.") < at("submit_review"));

  work = { kind: "elsewhere", last_message: "x".repeat(LAST_MESSAGE_CHARS + 10) };
  text = prompt("X-1", task, "ia/x-1", null, "abc", work, [], NO_REPLIES, "");
  assert.ok(text.includes(`> ${"x".repeat(LAST_MESSAGE_CHARS)} [...]`));
});

test("a_branch_without_commits_is_reviewed_only_when_the_agent_changed_code", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "task"));
  const dir = testing.temp_dir();
  execFileSync("git", ["init", "-q", dir]);
  let n = 0;
  // A tool call, and its result unless `result` is null (declined or cut short).
  const tool = (name: string, input: any, result: boolean | null) => {
    n += 1;
    const id = `t${n}`;
    s.add_message(task.id, "claude", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    if (result !== null) {
      s.add_message(task.id, "claude", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "", is_error: result }] } });
    }
  };
  // Only read and answered, and its edits failed or were declined.
  tool("Read", { file_path: "README.md" }, false);
  tool("Bash", { command: "git log -3 > /tmp/log" }, false);
  tool("ApplyPatch", { changes: [] }, true);
  tool("Edit", { file_path: "/src/deploy/a.yml" }, null);
  tool("Write", { file_path: "/src/deploy/b.yml" }, true);
  assert.ok(!(await changed_elsewhere(s, task, dir, null)));
  const with_pr = { ...task, pr_url: "https://github.com/o/deploy/pull/4" };
  assert.ok(await changed_elsewhere(s, with_pr, dir, null));

  tool("Bash", { command: "git -C '../deploy repo' commit -am x" }, false);
  assert.ok(await changed_elsewhere(s, task, dir, null));
  // After a review, only what the agent did since counts, and uncommitted changes.
  await sleep(5);
  const review: Review = { ...db.Review_default(), state: "issues", updated_at: now() };
  assert.ok(!(await changed_elsewhere(s, with_pr, dir, review)));
  writeFileSync(join(dir, "a.txt"), "x");
  assert.ok(await changed_elsewhere(s, task, dir, review));
  rmSync(join(dir, "a.txt"));
  await sleep(5);
  tool("Bash", { command: "sed -i 's/a/b/' /src/deploy/a.yml && false" }, true);
  assert.ok(await changed_elsewhere(s, task, dir, review));
  // An unfinished review doesn't count.
  const stopped: Review = { ...db.Review_default(), state: "stopped", updated_at: now() };
  assert.ok(await changed_elsewhere(s, task, dir, stopped));
});

/** A task in review with a review in progress by `n` reviewers, and their threads. */
function reviewing(s: AppState, n: number): [Task, Task[]] {
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "task"));
  const threads = Array.from({ length: n }, () => {
    const t = db.insert_task(s.db(), new_task(p.id, "review"));
    return s.update_task(t.id, [["parent_id", task.id]])!;
  });
  const parts: ReviewerRun[] = threads.map((t, i) => ({ ...db.ReviewerRun_default(), thread_id: t.id, label: `r${i}`, state: "running" }));
  const review: Review = { ...db.Review_default(), thread_id: threads[0].id, state: "running", reviewers: parts, updated_at: now() };
  set_review(s, task.id, review);
  return [task, threads];
}

function review_of(s: AppState, task: Task): Review {
  return db.get_task(s.db(), task.id)!.review!;
}

test("the_review_waits_for_every_reviewer_and_combines_their_issues", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 3);
  submit(s, threads[0], "run", { verdict: "pass", summary: "Looks good." });
  finished(s, threads[0], "run", "Ok", null);
  let r = review_of(s, task);
  assert.deepEqual([r.state, r.reviewers[0].state], ["running", "passed"]);

  submit(s, threads[1], "run", { verdict: "needs_fixes", summary: "One bug.", serious_issues: ["the bug"] });
  finished(s, threads[1], "run", "Ok", null);
  assert.equal(review_of(s, task).state, "running");

  // The last one fails: the issues the others found still count.
  finished(s, threads[2], "run", { Failed: "boom" }, null);
  r = review_of(s, task);
  assert.equal(r.state, "issues");
  assert.deepEqual(r.issues, ["(r1) the bug"]);
  assert.deepEqual(
    r.reviewers.map((p) => p.state),
    ["passed", "issues", "failed"],
  );
  const summary = r.summary!;
  assert.ok(summary.includes("**r0:** Looks good.") && summary.includes("**r1:** One bug."), summary);
  // No fix rounds (it has no project): left for the user.
  assert.equal(db.get_task(s.db(), task.id)!.status, "needs_attention");

  // A reviewer that has finished can't submit again.
  assert.throws(() => submit(s, threads[0], "run", { verdict: "pass" }));
});

test("each_submission_is_kept_for_statistics", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 2);
  const review = review_of(s, task);
  review.started_at = "2026-10-01T10:00:00.000Z";
  set_review(s, task.id, review);
  submit(s, threads[0], "run1", { verdict: "pass", summary: "Fine at first." });
  // Submitted again in the same run: this one counts instead.
  const args = { verdict: "needs_fixes", summary: "One bug, and a nit.", serious_issues: ["the bug"], minor_issues: ["a nit", "another"] };
  submit(s, threads[0], "run1", args);
  submit(s, threads[1], "run2", { verdict: "pass", summary: "Fine." });
  const rows = db
    .all(s.db(), "SELECT task_id, thread_id, round, run_id, verdict, serious, minor, minor_noted, label FROM review_stats ORDER BY id")
    .map((r: any) => [r.task_id, r.thread_id, r.round, r.run_id, r.verdict, r.serious, r.minor, !!r.minor_noted, r.label]);
  // Both in the round the review started.
  const round = "2026-10-01T10:00:00.000Z";
  assert.deepEqual(rows, [
    [task.id, threads[0].id, round, "run1", "issues", 1, 2, true, "r0"],
    [task.id, threads[1].id, round, "run2", "pass", 0, 0, false, "r1"],
  ]);
});

test("a_submission_keeps_the_effort_the_work_was_done_at", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 3);
  const effort = (thread: Task) => db.value(s.db(), "SELECT effort FROM review_stats WHERE thread_id=?1", thread.id) ?? null;
  const work = (at: string, effort: string | null) => {
    const r = db.insert_run(s.db(), task.id, "prompt");
    db.run(s.db(), "UPDATE runs SET created_at=?1, effort=?2 WHERE id=?3", at, effort, r.id);
  };
  // A task from before runs kept their efforts: what it's set to now, the host's default while it has none of its own.
  db.set_setting(s.db(), "default_effort", "medium");
  work("2000-01-01T00:00:00.000Z", null);
  submit(s, threads[0], "run1", { verdict: "pass", summary: "Fine." });
  // The work run's own effort, as its agent was given it (see runner/launch.rs), whatever the task and the host are set to after.
  work("2000-01-02T00:00:00.000Z", "low");
  s.update_task(task.id, [["effort", "xhigh"]]);
  db.set_setting(s.db(), "default_effort", "max");
  submit(s, threads[1], "run2", { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["x"] });
  // A run the agent's own default.
  work("2000-01-03T00:00:00.000Z", "");
  submit(s, threads[2], "run3", { verdict: "pass", summary: "Fine." });
  assert.deepEqual([effort(threads[0]), effort(threads[1]), effort(threads[2])], ["medium", "low", null]);
  // And the report has it, with the model the task's agent used before the review.
  const c = s.db();
  const run = (at: string, kind: string, model: string, out: number) => {
    const r = db.insert_run(c, task.id, kind);
    db.run(c, "UPDATE runs SET created_at=?1 WHERE id=?2", at, r.id);
    db.run(c, "INSERT INTO token_usage (run_id, model, runtime, output_tokens) VALUES (?1, ?2, 'claude', ?3)", r.id, model, out);
  };
  run("2000-01-01T00:00:00.000Z", "prompt", "sonnet", 100);
  run("2000-01-02T00:00:00.000Z", "prompt", "opus", 100);
  run("2000-01-02T00:00:00.000Z", "compact", "haiku", 100);
  run("2100-01-01T00:00:00.000Z", "prompt", "haiku", 100);
  const r = analytics.token_report(c, task.profile_id, "2000-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z");
  assert.deepEqual(
    r.reviews.map((v: any) => [v.effort ?? null, v.task_model ?? null]),
    [
      ["medium", "opus"],
      ["low", "opus"],
      [null, "opus"],
    ],
  );
});

test("a_review_started_before_rounds_were_kept_is_one_round", () => {
  const s = testing.state();
  // Its review has no start: its reviewers' runs started half a minute apart.
  const [task, threads] = reviewing(s, 2);
  const run = (thread: Task, at: string) => {
    const r = db.insert_run(s.db(), thread.id, "review");
    db.run(s.db(), "UPDATE runs SET created_at=?1 WHERE id=?2", at, r.id);
    return r.id;
  };
  const [a, b] = [run(threads[0], "2026-10-01T10:00:00.000Z"), run(threads[1], "2026-10-01T10:00:30.000Z")];
  submit(s, threads[0], a, { verdict: "pass", summary: "Fine." });
  submit(s, threads[1], b, { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["x"] });
  const c = s.db();
  const rounds = db.all(c, "SELECT round FROM review_stats ORDER BY id").map((r: any) => r.round);
  assert.deepEqual(rounds, ["2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z"]);
  const r = analytics.token_report(c, task.profile_id, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
  assert.deepEqual(
    r.rounds.map((x: any) => [x.round, x.verdict, x.reviewers]),
    [[1, "issues", 2]],
  );
});

test("a_review_passes_when_every_reviewer_passes", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 2);
  for (const t of threads) {
    submit(s, t, "run", { verdict: "pass" });
    finished(s, t, "run", "Ok", null);
  }
  const r = review_of(s, task);
  assert.equal(r.state, "passed");
  assert.deepEqual(r.issues, []);
  assert.equal(db.get_task(s.db(), task.id)!.status, "in_review");
});

test("superseding_stops_every_reviewer", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 2);
  submit(s, threads[0], "run", { verdict: "pass" });
  finished(s, threads[0], "run", "Ok", null);
  supersede(s, task);
  const r = review_of(s, task);
  assert.equal(r.state, "stopped");
  assert.deepEqual(
    r.reviewers.map((p) => p.state),
    ["passed", "stopped"],
  );
  // The stopped run ending doesn't change it.
  finished(s, threads[1], "run", "Cancelled", null);
  assert.equal(review_of(s, task).state, "stopped");
});

test("stopping_the_task_stops_its_review", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 2);
  assert.ok(stop(s, task.id));
  const r = review_of(s, task);
  assert.deepEqual([r.state, r.summary], ["stopped", "Stopped by the user."]);
  assert.ok(r.reviewers.every((p) => p.state === "stopped"));
  finished(s, threads[0], "run", "Cancelled", null);
  assert.equal(review_of(s, task).state, "stopped");
  // Nothing left to stop.
  assert.ok(!stop(s, task.id));
});

test("a_review_from_before_several_reviewers_still_finishes", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 1);
  const old: Review = { ...db.Review_default(), thread_id: threads[0].id, state: "running", updated_at: now() };
  set_review(s, task.id, old);
  submit(s, threads[0], "run", { verdict: "pass", summary: "Fine." });
  finished(s, threads[0], "run", "Ok", null);
  const r = review_of(s, task);
  assert.deepEqual([r.state, r.summary], ["passed", "Fine."]);
});

test("reviewers_are_labelled_by_config_model_and_effort", () => {
  const c = { id: "c", name: "Codex", config_dir: "", agent: "codex" } as ClaudeConfig;
  assert.equal(label(c, "gpt-5", "high"), "Codex · gpt-5 · high");
  assert.equal(label(null, null, null), "Claude");
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const AS = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A task in a project that reviews automatically, with a worktree branch with a commit. */
function reviewable(s: AppState): [Task, string] {
  const p = db.insert_profile(s.db(), "p", [], null);
  const np = { id: "pr", profile_id: p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: true };
  db.insert_project(s.db(), np);
  const task = db.insert_task(s.db(), { ...new_task(p.id, "task"), project_id: "pr" });
  const dir = testing.temp_dir();
  git(dir, ["init", "-q"]);
  git(dir, [...AS, "commit", "-q", "--allow-empty", "-m", "work"]);
  const fields: Array<[string, any]> = [
    ["worktree_path", dir],
    ["worktree_state", "ready"],
    ["branch", "ia/x"],
  ];
  return [db.update_task(s.db(), task.id, fields)!, dir];
}

/** The text of the first message sent to a thread. */
function asked(s: AppState, thread_id: string): string {
  return testing.messages(s.db(), thread_id).find((m: any) => m.kind === "user")!.data.text;
}

test("each_reviewer_looks_for_what_its_own_instructions_say_and_has_its_own_skills", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [task] = reviewable(s);
    db.update_project(s.db(), "pr", [["review_prompt", "Check the project's rules."]]);
    const security = { ...db.Reviewer_default(), model: "opus", prompt: " Only look for security holes. ", skills: ["audit"] };
    const plain = { ...db.Reviewer_default(), model: "haiku" };
    db.update_project(s.db(), "pr", [["reviewers", JSON.stringify([security, plain])]]);
    assert.ok(await start(s, task.id, true), "it starts");
    const r = review_of(s, task);
    const [a, b] = [asked(s, r.reviewers[0].thread_id), asked(s, r.reviewers[1].thread_id)];
    assert.ok(a.includes("Only look for security holes.") && !a.includes("Check the project's rules."), a);
    assert.ok(a.includes("Use this skill while you review: `/audit` (invoke each with the `Skill` tool).") && !b.includes("while you review"), a);
    assert.ok(b.includes("Check the project's rules.") && !b.includes("security holes"), b);
    assert.deepEqual(db.thread_skills(s.db(), r.reviewers[0].thread_id), ["audit"]);
    assert.deepEqual(db.thread_skills(s.db(), r.reviewers[1].thread_id), []);

    // Reviewed again with other settings, the same threads follow them.
    supersede(s, task);
    const again = { ...db.Reviewer_default(), model: "opus" };
    db.update_project(s.db(), "pr", [["reviewers", JSON.stringify([again])]]);
    assert.ok(await start(s, task.id, true), "it starts again");
    const r2 = review_of(s, task);
    assert.equal(r2.reviewers[0].thread_id, r.reviewers[0].thread_id);
    assert.deepEqual(db.thread_skills(s.db(), r.reviewers[0].thread_id), []);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_review_doesnt_start_once_the_agent_has_started_again", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [task] = reviewable(s);
    // The agent starts again while the review reads the worktree's git state.
    testing.when("review:recording", () => {
      const run = db.insert_run(s.db(), task.id, "prompt");
      s.runs.set(task.id, { run_id: run.id, cancel: null });
      supersede(s, task);
    });
    assert.equal(await start(s, task.id, false), null);
    const t = db.get_task(s.db(), task.id)!;
    assert.equal(t.review, null, JSON.stringify(t.review));
    for (const thread of db.review_threads(s.db(), task.id)) assert.ok(!s.is_running(thread.id), "no reviewer started");
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

/** The task's review once one has been recorded (started in the background), within 10 seconds. */
async function review_started(s: AppState, task: Task): Promise<Review | null> {
  let review: Review | null = null;
  for (const until = Date.now() + 10_000; !review && Date.now() < until; ) {
    review = db.get_task(s.db(), task.id)!.review;
    if (!review) await sleep(10);
  }
  return review;
}

test("a_review_doesnt_start_on_work_changed_while_it_was_read", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [task, dir] = reviewable(s);
    // A run starts, commits and ends while the review reads the worktree's git state.
    testing.when("review:recording", () => {
      const run = db.insert_run(s.db(), task.id, "prompt");
      s.runs.set(task.id, { run_id: run.id, cancel: null });
      supersede(s, task);
      git(dir, [...AS, "commit", "-q", "--allow-empty", "-m", "more work"]);
      db.run(s.db(), "UPDATE runs SET status='running', saw_result=1 WHERE id=?1", run.id);
      runner.on_exit(s, run.id, 0, null, null, "");
    });
    assert.equal(await start(s, task.id, false), null);
    const t = db.get_task(s.db(), task.id)!;
    assert.equal(t.review, null, JSON.stringify(t.review));
    // The run's own end reviews it.
    const head = await rev_parse(dir, "HEAD");
    const review = await review_started(s, task);
    assert.equal(review?.head, head);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_review_doesnt_start_on_work_changed_by_a_run_that_started_as_it_did", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [task, dir] = reviewable(s);
    // A run starts as the review looks for the task's last one, then commits and ends while git is read.
    const run = db.insert_run(s.db(), task.id, "prompt");
    testing.when("review:last-run", () => {
      s.runs.set(task.id, { run_id: run.id, cancel: null });
      supersede(s, task);
    });
    // (As in Rust, the run counts as running at the check after "review:last-run", so the review stops there and
    // this hook isn't reached. Hooks aren't per test here as Rust's thread-local ones are: `live` keeps it from acting
    // on a later test's review.)
    let live = true;
    testing.when("review:recording", () => {
      if (!live) return;
      git(dir, [...AS, "commit", "-q", "--allow-empty", "-m", "more work"]);
      db.run(s.db(), "UPDATE runs SET status='running', saw_result=1 WHERE id=?1", run.id);
      runner.on_exit(s, run.id, 0, null, null, "");
    });
    assert.equal(await start(s, task.id, false), null);
    const t = db.get_task(s.db(), task.id)!;
    assert.equal(t.review, null, JSON.stringify(t.review));
    live = false;
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_review_superseded_as_it_starts_leaves_the_task_to_its_agent", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    for (const fails of [false, true]) {
      const s = testing.state();
      const [reviewed] = reviewable(s);
      const task = s.update_task(reviewed.id, [["status", "needs_attention"]])!;
      // The user sends the agent more work once the reviewer has started; that run may fail at once.
      testing.when("review:reviewer-started", () => {
        runner.send(s, task.id, "more work");
        if (fails) {
          const run = s.runs.get(task.id)!.run_id;
          runner.on_exit(s, run, null, null, "it didn't start", "");
        }
      });
      await start(s, task.id, true);
      const t = db.get_task(s.db(), task.id)!;
      assert.equal(t.review?.state, "stopped");
      if (!fails) {
        assert.deepEqual([t.running, t.status], [true, "in_progress"]);
      } else {
        assert.deepEqual([t.running, t.status], [false, "needs_attention"]);
        assert.ok(t.attention_reason?.includes("it didn't start"));
      }
    }
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_verdict_from_an_earlier_round_doesnt_count", async () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 1);
  const thread = threads[0];
  const round = (after: string) => {
    const r = review_of(s, task);
    r.state = "running";
    r.reviewers[0].state = "running";
    r.reviewers[0].after_run = after;
    set_review(s, task.id, r);
  };
  round("");
  const a = db.insert_run(s.db(), thread.id, "review");
  // A's verdict is cut short by a restart, then A ends and B starts the next round.
  const call = () => ({ task_fields: true, run_id: a.id, call_id: "a", tool: "submit_review", args: { verdict: "pass", summary: "Fine.", serious_issues: [] } });
  testing.when("mcp:executed", () => {
    throw new Error("the server stopped");
  });
  await assert.rejects(async () => tools.handle_mcp(s, call() as any));
  finished(s, thread, a.id, "Ok", null);
  round(a.id);
  const b = db.insert_run(s.db(), thread.id, "review");
  submit(s, thread, b.id, { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["the bug"] });
  // A's verdict, retried, is turned away; B's stands.
  await assert.rejects(
    async () => tools.handle_mcp(s, call() as any),
    (e) => err_str(e).includes("has ended"),
  );
  assert.throws(() => submit(s, thread, a.id, { verdict: "pass" }));
  finished(s, thread, b.id, "Ok", null);
  const r = review_of(s, task);
  assert.deepEqual([r.state, r.issues], ["issues", ["the bug"]]);
});

test("a_reviewer_started_just_before_a_restart_still_ends_its_part", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [task] = reviewable(s);
    testing.when("review:reviewer-started", () => {
      throw new Error("the server stopped");
    });
    await assert.rejects(start(s, task.id, true));
    assert.equal(review_of(s, task).state, "running");
    // The restart fails the run, which hadn't started its agent: its part ends with it.
    s.runs.clear();
    runner.load_active(s);
    const r = review_of(s, task);
    assert.deepEqual([r.state, r.reviewers[0].state], ["failed", "failed"]);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_task_that_started_after_its_base_branch_is_reviewed_from_where_it_started", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    // It starts at a commit master doesn't have, or at master's latest, and has a pull request
    // into master either way.
    for (const off_master of [true, false]) {
      const s = testing.state();
      const [task, dir] = reviewable(s);
      git(dir, ["branch", "-q", "-m", "master"]);
      let from: string;
      if (off_master) {
        git(dir, [...AS, "commit", "-q", "--allow-empty", "-m", "someone else's"]);
        from = git(dir, ["rev-parse", "HEAD"]);
      } else {
        from = git(dir, ["rev-parse", "master"]);
      }
      git(dir, ["checkout", "-q", "-b", "ia/x"]);
      if (off_master) git(dir, ["branch", "-q", "-f", "master", "HEAD~1"]);
      git(dir, ["update-ref", `refs/huntaway/start/${task.id}`, "HEAD"]);
      git(dir, [...AS, "commit", "-q", "--allow-empty", "-m", "its own"]);
      const fields: Array<[string, any]> = [
        ["base_branch", "master"],
        ["start_from", { type: "commit", commit: from }],
        ["pr_url", "https://github.com/o/r/pull/3"],
      ];
      db.update_task(s.db(), task.id, fields);
      await start(s, task.id, true);
      const thread = db.review_threads(s.db(), task.id)[0];
      const sent = testing
        .messages(s.db(), thread.id)
        .map((m: any) => JSON.stringify(m.data))
        .join("");
      const own = `\`git diff ${from}...HEAD\`) rather than \`pr_diff\``;
      if (off_master) assert.ok(sent.includes(own) && sent.includes("only for its description and comments"), sent);
      else assert.ok(!sent.includes("rather than `pr_diff`") && sent.includes("review the pull request's changes"), sent);
      supersede(s, db.get_task(s.db(), task.id)!);
    }
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

/** A task in a project with `rounds` rounds of fixes whose review found an issue after `fixes` of them. */
function out_of_rounds(s: AppState, rounds: number, fixes: number): Task {
  const [task, dir] = reviewable(s);
  rmSync(dir, { recursive: true, force: true });
  db.run(s.db(), "UPDATE projects SET review_rounds=?1 WHERE id='pr'", rounds);
  const review: Review = { ...db.Review_default(), thread_id: "r", state: "issues", issues: ["the bug"], fixes, updated_at: now() };
  set_review(s, task.id, review);
  return s.update_task(task.id, [
    ["status", "needs_attention"],
    ["attention_reason", "found"],
  ])!;
}

test("a_task_out_of_rounds_of_fixes_can_be_given_as_many_again", () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const task = out_of_rounds(s, 2, 2);
    const t = extend(s, task.id);
    assert.deepEqual([t.status, t.attention_reason], ["in_progress", null]);
    assert.ok(s.is_running(task.id));
    const r = review_of(s, task);
    assert.deepEqual([r.fixes, r.extra_rounds], [3, 2]);
    const sent = testing
      .messages(s.db(), task.id)
      .reverse()
      .find((m: any) => m.kind === "user")!;
    assert.equal(sent.data.review_round, 3);
    assert.ok(sent.data.text.includes("1. the bug"));
    // Not twice.
    assert.throws(
      () => extend(s, task.id),
      (e) => err_str(e).includes("hasn't used up"),
    );
    runner.stop(s, task.id);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("the_extra_rounds_of_fixes_count_until_theyre_used_up", () => {
  const s = testing.state();
  const task = out_of_rounds(s, 2, 2);
  s.update_task(task.id, [["status", "in_review"]]);
  const found = (fixes: number): Review => ({ ...db.Review_default(), state: "issues", issues: ["still"], fixes, extra_rounds: 2, updated_at: now() });
  const save = (r: Review) => set_review(s, task.id, r);
  // A round left: it goes to the agent (which can't start here).
  let t = db.get_task(s.db(), task.id)!;
  send_issues(s, t, found(3), 2, save);
  assert.equal(review_of(s, task).fixes, 4);
  assert.equal(db.get_task(s.db(), task.id)!.status, "in_review");
  // None left: it's left for the user.
  t = db.get_task(s.db(), task.id)!;
  send_issues(s, t, found(4), 2, save);
  t = db.get_task(s.db(), task.id)!;
  assert.deepEqual([t.status, t.attention_reason], ["needs_attention", "The review found 1 serious issue after 4 rounds of fixes"]);
});

test("rounds_of_fixes_are_given_back_if_the_agent_cant_start", () => {
  const s = testing.state();
  // A project with no rounds of fixes gets one.
  const task = out_of_rounds(s, 0, 0);
  // This host can't run agents.
  assert.throws(() => extend(s, task.id));
  let r = review_of(s, task);
  assert.deepEqual([r.fixes, r.extra_rounds], [0, 0]);
  assert.equal(db.get_task(s.db(), task.id)!.status, "needs_attention");

  runs.TEST_CAN_RUN.set(true);
  try {
    extend(s, task.id);
    r = review_of(s, task);
    assert.deepEqual([r.fixes, r.extra_rounds], [1, 1]);
    runner.stop(s, task.id);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("only_a_review_with_issues_left_after_its_rounds_can_be_extended", () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const task = out_of_rounds(s, 2, 1);
    assert.throws(
      () => extend(s, task.id),
      (e) => err_str(e).includes("hasn't used up"),
    );
    const passed: Review = { ...db.Review_default(), state: "passed", fixes: 2, updated_at: now() };
    set_review(s, task.id, passed);
    assert.throws(
      () => extend(s, task.id),
      (e) => err_str(e).includes("didn't find issues"),
    );
    assert.ok(!s.is_running(task.id));
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("rounds_added_to_a_cycle_of_fixes_end_with_it", () => {
  const s = testing.state();
  const [task, threads] = reviewing(s, 1);
  const extended: Review = { ...review_of(s, task), fixes: 3, extra_rounds: 2 };
  set_review(s, task.id, extended);
  submit(s, threads[0], "run", { verdict: "pass" });
  finished(s, threads[0], "run", "Ok", null);
  const r = review_of(s, task);
  // So the next automatic review, which carries both on, gets the project's rounds.
  assert.deepEqual([r.state, r.fixes, r.extra_rounds], ["passed", 0, 0]);
});
