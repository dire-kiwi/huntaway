// The tests of server/src/review/summary.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as db from "../db.ts";
import type { ChangeSummary, Reviewer, Task } from "../db.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as worktree from "../git/worktree.ts";
import * as review from "../review.ts";
import * as testing from "../testing.ts";
import type { AppState } from "../state.ts";
import { now } from "../util.ts";
import { is_summary, prompt, start, stop } from "./summary.ts";

// As in Rust's tests, there's no ia-shim: this host can't run agents unless a test says it can (runs::TEST_CAN_RUN).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

const R = (r: Partial<Reviewer>): Reviewer => ({ ...db.Reviewer_default(), ...r });

function plain_task(): Task {
  const c = db.open(":memory:");
  const p = db.insert_profile(c, "p", [], null);
  const t = { profile_id: p.id, project_id: null, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: null, effort: null, claude_config_id: null };
  return db.insert_task(c, t);
}

test("the_prompt_locates_the_work_and_asks_for_only_the_summary", () => {
  const task = plain_task();
  task.review = { ...db.Review_default(), state: "passed", summary: "Looks good." };
  let text = prompt("X-1", task, "ia/x-1", "master", "abc", false, false, null, db.Reviewer_default(), false);
  for (const want of ['task X-1: "Fix it"', "`pr_view` tool (pr `ia/x-1`)", "`git diff master...HEAD`", "> Looks good.", "end your turn with only the summary"]) {
    assert.ok(text.includes(want), `${JSON.stringify(want)} not in ${text}`);
  }
  text = prompt("X-1", task, "ia/x-1", "master", "abc", true, false, "Done in o/deploy#4.", db.Reviewer_default(), false);
  assert.ok(text.includes("no commits of its own") && text.includes("> Done in o/deploy#4."), text);
  assert.ok(!text.includes("skill"), text);
});

test("the_prompt_asks_for_a_summarizers_skills_and_prompt", () => {
  const task = plain_task();
  const spec = R({ skills: ["tldr", "changelog"], prompt: "  Two bullets, no more.  " });
  const text = prompt("X-1", task, "ia/x-1", "master", "abc", false, false, null, spec, false);
  assert.ok(text.includes("these skills while you write the summary: `/tldr`, `/changelog` (invoke each with the `Skill` tool)"), text);
  // Its prompt is the board's instead of the default, and the board still asks for only the summary.
  assert.ok(text.includes("Write it as they ask:\n\nTwo bullets, no more.\n") && !text.includes("Write it in Markdown, briefly"), text);
  assert.ok(text.includes("end your turn with only the summary"), text);
  const codex = prompt("X-1", task, "ia/x-1", "master", "abc", false, false, null, R({ skills: ["tldr"] }), true);
  assert.ok(codex.includes("this skill while you write the summary: `$tldr`.") && codex.includes("Write it in Markdown, briefly"), codex);
});

/** A task in review whose review passed, in a project that summarises, with a worktree branch with a commit. */
function passed(s: AppState): Task {
  const p = db.insert_profile(s.db(), "p", [], null);
  const np = { id: "pr", profile_id: p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: true };
  db.insert_project(s.db(), np);
  const fresh = { profile_id: p.id, project_id: "pr", kind: "task", title: "t", description: "", status: "in_review", use_worktree: true, model: null, effort: null, claude_config_id: null };
  const task = db.insert_task(s.db(), fresh);
  const dir = testing.temp_dir();
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
  const r = { ...db.Review_default(), thread_id: "r", state: "passed", summary: "Fine.", updated_at: now() };
  const fields: Array<[string, any]> = [
    ["worktree_path", dir],
    ["worktree_state", "ready"],
    ["branch", "ia/x"],
    ["review", r],
  ];
  return db.update_task(s.db(), task.id, fields)!;
}

const summary_of = (s: AppState, task: Task): ChangeSummary | null => db.get_task(s.db(), task.id)!.summary;
const get = (s: AppState, task: Task) => db.get_task(s.db(), task.id)!;

/** End the thread's run as a finished turn whose last message was `said`. */
function reply(s: AppState, thread: Task, said: string | null) {
  const h = s.runs.get(thread.id);
  assert.ok(h, "the summarizer is running");
  if (said != null) s.add_message(thread.id, "claude", { type: "result", subtype: "success", result: said });
  db.run(s.db(), "UPDATE runs SET saw_result=1 WHERE id=?1", h.run_id);
  runner.on_exit(s, h.run_id, 0, null, null, "");
}

const user_text = (s: AppState, th: Task): string => testing.messages(s.db(), th.id).find((m: any) => m.kind === "user")!.data.text;

/** Runs `f` as a host that can run agents (agents::runs::TEST_CAN_RUN). */
async function can_run(f: () => Promise<void> | void) {
  runs.TEST_CAN_RUN.set(true);
  try {
    await f();
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
}

test("a_passed_review_is_summarised_by_the_projects_summarizer", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    db.update_project(s.db(), "pr", [["summarizer", JSON.stringify(R({ model: "haiku" }))]]);
    assert.ok(await start(s, task.id, false), "it starts");
    let sum = summary_of(s, task)!;
    assert.deepEqual([sum.state, sum.label], ["running", "Claude · haiku"]);
    const threads = db.summary_threads(s.db(), task.id);
    assert.equal(threads.length, 1);
    const thread = threads[0];
    assert.deepEqual([thread.id, thread.model, thread.parent_id], [sum.thread_id, "haiku", task.id]);
    assert.ok(is_summary(thread));
    // It isn't one of the task's reviewers, though it works in the worktree as they do.
    assert.ok(worktree.agent_in_worktree(s, task.id));
    assert.ok(user_text(s, thread).includes("Summarise the changes made for task X-1"));

    reply(s, thread, "  ## What changed\n\nA fix.  ");
    sum = summary_of(s, task)!;
    assert.deepEqual([sum.state, sum.text], ["done", "## What changed\n\nA fix."]);
    // The task stays where it is.
    assert.equal(get(s, task).status, "in_review");
    // This commit has its summary; asked for, it's written again, in the same thread.
    assert.equal(await start(s, task.id, false), null);
    assert.ok(await start(s, task.id, true));
    assert.equal(db.summary_threads(s.db(), task.id).length, 1);
    // A run that says nothing new doesn't pass off the last summary as its own.
    reply(s, thread, null);
    sum = summary_of(s, task)!;
    assert.equal(sum.state, "failed", sum.text ?? "");
  }));

test("a_task_that_started_after_its_base_branch_is_summarised_from_where_it_started", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    const dir = task.worktree_path!;
    const git = (args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    // It starts at a commit master doesn't have, with someone else's work, and has a pull request into master.
    git(["branch", "-q", "-m", "master"]);
    git(["commit", "-q", "--allow-empty", "-m", "someone else's"]);
    const start_at = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "-b", "ia/x"]);
    git(["branch", "-q", "-f", "master", "HEAD~1"]);
    git(["update-ref", `refs/huntaway/start/${task.id}`, "HEAD"]);
    git(["commit", "-q", "--allow-empty", "-m", "its own"]);
    const fields: Array<[string, any]> = [
      ["base_branch", "master"],
      ["start_from", { type: "commit", commit: start_at }],
      ["pr_url", "https://github.com/o/r/pull/3"],
    ];
    db.update_task(s.db(), task.id, fields);
    assert.ok(await start(s, task.id, true), "it starts");
    const thread = db.summary_threads(s.db(), task.id)[0];
    const text = user_text(s, thread);
    assert.ok(text.includes(`\`git diff ${start_at}...HEAD\`, and \`git log ${start_at}..HEAD\`) rather than \`pr_diff\``), text);
    assert.ok(!text.includes("master...HEAD") && !text.includes("read its changes (`pr_diff`)"), text);
    reply(s, thread, "A summary.");
  }));

test("a_project_without_a_summarizer_uses_its_profiles", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    db.update_profile(s.db(), task.profile_id, [["summarizer", JSON.stringify(R({ model: "haiku" }))]]);
    assert.ok(await start(s, task.id, false), "it starts");
    assert.equal(summary_of(s, task)!.label, "Claude · haiku");
    const thread = db.summary_threads(s.db(), task.id)[0];
    reply(s, thread, "A summary.");
    // The project's own is used over it, in a thread of its own.
    db.update_project(s.db(), "pr", [["summarizer", JSON.stringify(R({ model: "sonnet" }))]]);
    assert.ok(await start(s, task.id, true));
    assert.equal(summary_of(s, task)!.label, "Claude · sonnet");
    assert.equal(db.summary_threads(s.db(), task.id).length, 2);
  }));

test("only_a_passed_review_in_a_project_that_summarises_is_summarised", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    db.update_project(s.db(), "pr", [["auto_summary", false]]);
    assert.equal(await start(s, task.id, false), null);
    db.update_project(s.db(), "pr", [["auto_summary", true]]);
    s.update_task(task.id, [["review", { ...db.Review_default(), state: "issues", updated_at: now() }]]);
    assert.equal(await start(s, task.id, false), null);
    s.update_task(task.id, [
      ["review", { ...db.Review_default(), state: "passed", updated_at: now() }],
      ["status", "ready_for_merge"],
    ]);
    assert.equal(await start(s, task.id, false), null);
    assert.ok(summary_of(s, task) == null && db.summary_threads(s.db(), task.id).length === 0);
  }));

test("the_agent_working_again_stops_the_summary", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    assert.ok(await start(s, task.id, false));
    const thread = db.summary_threads(s.db(), task.id)[0];
    runner.send(s, task.id, "one more thing");
    assert.equal(summary_of(s, task)!.state, "stopped");
    // Its run ending afterwards doesn't change that.
    reply(s, thread, "A summary.");
    assert.equal(summary_of(s, task)!.state, "stopped");
  }));

test("a_review_doesnt_take_the_summary_thread_for_a_reviewers", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    assert.ok(await start(s, task.id, false));
    const thread = db.summary_threads(s.db(), task.id)[0];
    reply(s, thread, "A summary.");
    assert.ok(await review.start(s, task.id, true));
    const r = get(s, task).review!;
    assert.notEqual(r.reviewers[0].thread_id, thread.id);
  }));

/** Both of a task's summarizers' threads, in the order of its summaries. */
function both(s: AppState, task: Task): Task[] {
  const summaries = get(s, task).summaries;
  const threads = db.summary_threads(s.db(), task.id);
  return summaries.map((sum) => threads.find((t) => t.id === sum.thread_id)!);
}

const PLAIN = () => R({ name: "Plain" });
const SKILLED = () => R({ name: "Skilled", skills: ["tldr"], prompt: "Be brief." });

function two_summarizers(s: AppState) {
  db.update_project(s.db(), "pr", [["summarizers", JSON.stringify([PLAIN(), SKILLED()])]]);
}

test("each_summarizer_writes_a_summary_in_a_thread_of_its_own", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    two_summarizers(s);
    assert.ok(await start(s, task.id, false), "it starts");
    const threads = both(s, task);
    assert.equal(threads.length, 2);
    assert.notEqual(threads[0].id, threads[1].id);
    let t = get(s, task);
    const names = t.summaries.map((x) => [x.name ?? null, x.state, x.skills ?? [], x.custom_prompt ?? false]);
    assert.deepEqual(names, [
      ["Plain", "running", [], false],
      ["Skilled", "running", ["tldr"], true],
    ]);
    // What older clients read is the first.
    assert.equal(t.summary?.thread_id, threads[0].id);
    assert.equal(threads[1].title, "Summary of X-1 · Skilled");
    assert.ok(!user_text(s, threads[0]).includes("/tldr") && user_text(s, threads[1]).includes("`/tldr`") && user_text(s, threads[1]).includes("Be brief."));

    // They finish on their own.
    reply(s, threads[1], "Short.");
    t = get(s, task);
    assert.deepEqual([t.summaries[0].state, t.summaries[1].state], ["running", "done"]);
    assert.equal(t.summaries[1].text, "Short.");
    reply(s, threads[0], "Long.");
    t = get(s, task);
    assert.deepEqual([t.summaries[0].text, t.summaries[1].text], ["Long.", "Short."]);

    // Both have this commit's summary; asked for, both are written again in the same threads.
    assert.equal(await start(s, task.id, false), null);
    assert.ok(await start(s, task.id, true));
    assert.equal(db.summary_threads(s.db(), task.id).length, 2);
  }));

test("a_summarizer_added_later_is_written_without_redoing_the_others", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    assert.ok(await start(s, task.id, false));
    const first = db.summary_threads(s.db(), task.id)[0];
    reply(s, first, "First.");
    const skilled = R({ skills: ["tldr"] });
    db.update_project(s.db(), "pr", [["summarizers", JSON.stringify([db.Reviewer_default(), skilled])]]);
    assert.ok(await start(s, task.id, false), "the new one starts");
    const t = get(s, task);
    assert.deepEqual([t.summaries.length, t.summaries[0].state, t.summaries[0].text, t.summaries[1].state], [2, "done", "First.", "running"]);
    // The first's thread wasn't asked again.
    assert.equal(testing.messages(s.db(), first.id).filter((m: any) => m.kind === "user").length, 1);
    // Without it, its summary goes.
    const second = both(s, task)[1];
    reply(s, second, "Second.");
    db.update_project(s.db(), "pr", [["summarizers", JSON.stringify([skilled])]]);
    assert.ok(await start(s, task.id, true));
    assert.equal(get(s, task).summaries.length, 1);
  }));

test("stopping_or_working_again_stops_every_summary_in_progress", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    two_summarizers(s);
    assert.ok(await start(s, task.id, false));
    const threads = both(s, task);
    reply(s, threads[0], "Done.");
    assert.ok(stop(s, task.id));
    const t = get(s, task);
    // Only the one still being written is stopped.
    assert.deepEqual([t.summaries[0].state, t.summaries[1].state], ["done", "stopped"]);
    assert.ok(!stop(s, task.id));
  }));

test("a_summary_saved_before_there_could_be_several_is_its_tasks_only_one", () => {
  const s = testing.state();
  const task = passed(s);
  const old = { thread_id: "t", label: "Claude · haiku", state: "done", head: "abc", text: "Old.", updated_at: "1" };
  db.run(s.db(), "UPDATE tasks SET summary=?2 WHERE id=?1", task.id, JSON.stringify(old));
  const t = get(s, task);
  assert.deepEqual([t.summaries.length, t.summary?.text], [1, "Old."]);
  // And a project's one `summarizer` is its only summarizer.
  const haiku = R({ model: "haiku" });
  db.run(s.db(), "UPDATE projects SET summarizer=?1, summarizers=NULL WHERE id='pr'", JSON.stringify(haiku));
  const p = db.get_project(s.db(), "pr")!;
  assert.deepEqual(db.summarizers_for(s.db(), p), [haiku]);
});

test("summarizers_taken_out_or_reordered_change_the_summaries_without_writing_again", () =>
  can_run(async () => {
    const s = testing.state();
    const task = passed(s);
    two_summarizers(s);
    assert.ok(await start(s, task.id, false));
    for (const t of both(s, task)) reply(s, t, "Done.");
    const names = () => get(s, task).summaries.map((x) => x.name);
    assert.deepEqual(names(), ["Plain", "Skilled"]);
    // Reordered: the summaries follow, and the first (what older clients read) is the new first.
    db.update_project(s.db(), "pr", [["summarizers", JSON.stringify([SKILLED(), PLAIN()])]]);
    assert.equal(await start(s, task.id, false), null);
    assert.deepEqual(names(), ["Skilled", "Plain"]);
    assert.equal(get(s, task).summary?.name, "Skilled");
    // One taken out: its summary goes.
    db.update_project(s.db(), "pr", [["summarizers", JSON.stringify([PLAIN()])]]);
    assert.equal(await start(s, task.id, false), null);
    assert.deepEqual(names(), ["Plain"]);
  }));
