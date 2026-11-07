// The tests of server/src/integrations/workflows/tests.rs (HA-173's branch, ported by HA-189), and more of HA-189's own.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as api from "../../api.ts";
import * as runs from "../../agent/runs.ts";
import * as merge_gate from "../../review/merge_gate.ts";
import type { Outcome } from "../../agent/runner.ts";
import * as testing from "../../testing.ts";
import type { AppState } from "../../state.ts";
import { now, sleep } from "../../util.ts";
import {
  Graph_from_json,
  check_graph,
  create,
  delete_,
  get_run,
  is_workflow,
  latest_run,
  latest_runs,
  on_status,
  on_finished,
  on_finish_due,
  resume,
  run_node,
  start,
  stop,
  submit,
  supersede,
  finished,
  update,
  upstream,
  insert_run,
  Run_from_row,
  type Run,
  type Workflow,
} from "../workflows.ts";
import { advance, board_opens_pr, engine_testing, MAX_CHAIN, merge_instructions, plan, start_instructions, step_ended } from "./engine.ts";
import { handle_mcp } from "../../mcp/tools.ts";
import { finish } from "../../agent/runner.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as prompt from "./prompt.ts";

// As in Rust's tests, there's no ia-shim: this host can't run agents unless a test says it can (runs::TEST_CAN_RUN).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/** A project, and a task in review with a worktree that has a commit of its own on a branch off master. */
function setup(s: AppState): [Project, Task, string] {
  const p = db.insert_profile(s.db(), "p", [], null);
  const np = {
    id: "pr",
    profile_id: p.id,
    name: "x",
    key: "X",
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: "master",
    use_worktrees: true,
  };
  const project = db.insert_project(s.db(), np);
  const task = db.insert_task(s.db(), {
    profile_id: p.id,
    project_id: "pr",
    kind: "task",
    title: "Fix the thing",
    description: "Make it work.",
    status: "in_review",
    use_worktree: true,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const dir = testing.temp_dir();
  const g = ["-c", "user.name=t", "-c", "user.email=t@t"];
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, [...g, "commit", "-q", "--allow-empty", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "ia/x-1"]);
  git(dir, [...g, "commit", "-q", "--allow-empty", "-m", "work"]);
  const fields: Array<[string, any]> = [
    ["worktree_path", dir],
    ["worktree_state", "ready"],
    ["branch", "ia/x-1"],
  ];
  return [project, db.update_task(s.db(), task.id, fields)!, dir];
}

/** Review, then fix rounds or a summary: what reviewers and summaries do, as a workflow. */
function review_graph(): any {
  return {
    nodes: [
      { id: "start", kind: "trigger", on: "status", status: "in_review" },
      { id: "changed", kind: "condition", check: "changed" },
      { id: "review", kind: "agent", name: "Reviewer", output: "verdict", tab: "Review" },
      { id: "fix", kind: "send_to_task", max_rounds: 1 },
      { id: "summary", kind: "agent", name: "Summary", output: "text", tab: "Summary", prompt: "Summarise {{task.key}}." },
    ],
    edges: [
      { from: "start", port: "out", to: "changed" },
      { from: "changed", port: "yes", to: "review" },
      { from: "review", port: "issues", to: "fix" },
      { from: "review", port: "pass", to: "summary" },
    ],
  };
}

function make(s: AppState, project: Project, graph: any): Workflow {
  return create(s, project.id, { name: "Review", graph });
}

function thread_of(s: AppState, run_id: string, node: string): Task {
  const run = get_run(s.db(), run_id)!;
  const id = run_node(run, node).thread_id;
  assert.ok(id, `${node} has no thread: ${JSON.stringify(run.nodes)}`);
  return db.get_task(s.db(), id)!;
}

/**
 * Ends the agent step's thread run as `outcome`, and moves the run on (here, rather than in the background, so the next
 * steps' agents, which fail to start in tests, don't end first).
 */
async function end(s: AppState, run_id: string, node: string, outcome: Outcome) {
  const thread = thread_of(s, run_id, node);
  const run = db.latest_run(s.db(), thread.id, null)!;
  s.runs.delete(thread.id);
  const id = step_ended(s, thread, run, outcome, null);
  assert.ok(id, "the step's run");
  await advance(s, id);
}

function last_user_text(s: AppState, task_id: string): string {
  const msgs = testing.messages(s.db(), task_id);
  const m = [...msgs].reverse().find((m: any) => m.kind === "user");
  return (m?.data?.text as string) ?? "";
}

/** A run of graph `g` as the tests make it by hand. */
function bare_run(g: any, task_id: string, head: string | null): Run {
  const run: any = {
    id: "r",
    workflow_id: "w",
    task_id,
    source: "manual",
    state: "running",
    head,
    graph: Graph_from_json(g),
    nodes: {},
    rounds: {},
    detail: null,
    created_at: now(),
    updated_at: now(),
    finished_at: null,
  };
  return db.hidden(run, "task_run", null);
}

async function until(f: () => boolean, ms = 2000) {
  for (let i = 0; i < ms / 10 && !f(); i++) await sleep(10);
}

test("a_graph_needs_a_start_real_ports_and_no_loops", () => {
  const s = testing.state();
  const [project] = setup(s);
  const c = s.db();
  check_graph(c, project, review_graph());
  const bad = (g: any, what: string) => {
    assert.throws(
      () => check_graph(c, project, g),
      (e: any) => {
        assert.ok(e.message.includes(what), e.message);
        assert.equal(e.status, 400);
        return true;
      },
    );
  };
  bad({ nodes: [], edges: [] }, "needs a column node");
  bad({ nodes: [{ id: "a", kind: "trigger", on: "status" }], edges: [] }, "needs its column");
  bad(
    {
      nodes: [
        { id: "a", kind: "trigger", on: "manual" },
        { id: "b", kind: "trigger", on: "manual" },
      ],
      edges: [],
    },
    "one start",
  );
  const two = {
    nodes: [
      { id: "a", kind: "trigger", on: "manual" },
      { id: "b", kind: "set_status", status: "todo" },
    ],
    edges: [{ from: "a", port: "yes", to: "b" }],
  };
  bad(two, "has no port yes");
  const into_trigger = {
    nodes: [
      { id: "a", kind: "trigger", on: "manual" },
      { id: "b", kind: "set_status", status: "todo" },
    ],
    edges: [{ from: "b", port: "out", to: "a" }],
  };
  bad(into_trigger, "into the start");
  const looped = {
    nodes: [
      { id: "a", kind: "trigger", on: "manual" },
      { id: "b", kind: "agent", name: "B" },
      { id: "c", kind: "agent", name: "C" },
    ],
    edges: [
      { from: "a", port: "out", to: "b" },
      { from: "b", port: "done", to: "c" },
      { from: "c", port: "done", to: "b" },
    ],
  };
  bad(looped, "loop through b");
  // Round again through a column is no loop: the path ends there, and the next run starts from it.
  check_graph(c, project, {
    nodes: [
      { id: "w", kind: "column", status: "in_progress" },
      { id: "r", kind: "agent", name: "R", output: "verdict" },
      { id: "v", kind: "column", status: "in_review" },
    ],
    edges: [
      { from: "w", port: "done", to: "v" },
      { from: "v", port: "done", to: "r" },
      { from: "r", port: "issues", to: "w" },
    ],
  });
  const manual = { id: "a", kind: "trigger", on: "manual" };
  bad({ nodes: [manual, { id: "b", kind: "column", status: "nowhere" }], edges: [] }, "needs a column");
  bad({ nodes: [manual, { id: "b", kind: "column", status: "done", prompt: "Hi" }], edges: [] }, "no work in Done");
  bad({ nodes: [manual, { id: "b", kind: "column", status: "needs_attention", prompt: "Hi" }], edges: [] }, "waits for the user");
  bad(
    {
      nodes: [manual, { id: "b", kind: "column", status: "done" }],
      edges: [{ from: "a", port: "out", to: "b" }],
    },
    "into Done",
  );
  bad(
    {
      nodes: [
        { id: "b", kind: "column", status: "in_review" },
        { id: "c", kind: "set_status", status: "in_review" },
      ],
      edges: [],
    },
    "two nodes are the column In review",
  );
  bad({ nodes: [{ id: "b", kind: "column", status: "ready_for_merge", done_when: "finish" }], edges: [] }, "when the task is merged");
  bad({ nodes: [manual, { id: "b", kind: "agent", name: " " }], edges: [] }, "needs a name");
  bad({ nodes: [manual, { id: "b", kind: "agent", name: "R", claude_config_id: "nope" }], edges: [] }, "agent configs");
  bad({ nodes: [manual, { id: "a", kind: "set_status", status: "todo" }], edges: [] }, "two nodes");
  // What serde refuses (HA-189).
  bad({ nodes: [manual, { id: "b", kind: "teleport" }], edges: [] }, "graph: unknown variant `teleport`");
  bad({ nodes: [manual, { id: "b", kind: "set_status" }], edges: [] }, "graph: missing field `status`");
  // Blank settings are dropped, and a manual trigger keeps no column.
  const g = check_graph(c, project, {
    nodes: [
      { id: "a", kind: "trigger", on: "manual", status: "todo" },
      { id: "b", kind: "agent", name: " R ", model: " ", skills: ["/tldr", ""] },
    ],
    edges: [],
  });
  assert.deepEqual(g.nodes[0], { id: "a", kind: "trigger", on: "manual", x: 0, y: 0 });
  const b: any = g.nodes[1];
  assert.deepEqual([b.name, b.model, b.skills], ["R", undefined, ["tldr"]]);
  assert.ok(!("model" in b), "a blank model isn't kept");
});

test("a_node_runs_when_its_inputs_are_taken_and_is_skipped_otherwise", () => {
  const run = bare_run(
    {
      nodes: [
        { id: "t", kind: "trigger", on: "manual" },
        { id: "a", kind: "agent", name: "A", output: "verdict" },
        { id: "b", kind: "agent", name: "B", output: "verdict" },
        { id: "any", kind: "send_to_task" },
        { id: "all", kind: "agent", name: "Summary", join: "all" },
        { id: "after", kind: "set_status", status: "todo" },
      ],
      edges: [
        { from: "t", port: "out", to: "a" },
        { from: "t", port: "out", to: "b" },
        { from: "a", port: "issues", to: "any" },
        { from: "b", port: "issues", to: "any" },
        { from: "a", port: "pass", to: "all" },
        { from: "b", port: "pass", to: "all" },
        { from: "all", port: "done", to: "after" },
      ],
    },
    "t",
    null,
  );
  run.nodes.t = { state: "done", port: "out" };
  assert.deepEqual(plan(run).sort(), ["a", "b"]);
  assert.deepEqual(plan(run), [], "nothing more until they finish");
  const end = (id: string, port: string) => {
    run.nodes[id].state = "done";
    run.nodes[id].port = port;
  };
  end("a", "pass");
  assert.deepEqual(plan(run), [], "both wait for b");
  end("b", "issues");
  // One reviewer found issues: they're sent, and the summary (after both pass) and what follows it are skipped.
  assert.deepEqual(plan(run), ["any"]);
  assert.deepEqual([run_node(run, "all").state, run_node(run, "after").state], ["skipped", "skipped"]);
});

test("templates_take_the_task_and_earlier_steps", () => {
  const s = testing.state();
  const [, task] = setup(s);
  const run = bare_run(review_graph(), task.id, "abc");
  run.nodes.review = { state: "done", port: "issues", text: "Nearly.", issues: ["a bug", "another"] };
  const out = prompt.render(
    "{{task.key}} {{ task.title }} on {{branch}} at {{commit}}: {{review.text}}\n{{issues}} {{nope}} {{unclosed",
    task,
    "X-1",
    "W",
    run,
  );
  assert.equal(out, "X-1 Fix the thing on ia/x-1 at abc: Nearly.\n1. a bug\n\n2. another {{nope}} {{unclosed");
});

test("a_review_workflow_sends_its_issues_then_summarises_once_it_passes", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    const w = make(s, project, review_graph());

    // Round 1: the review finds an issue, which goes to the task's agent.
    let run = (await start(s, w.id, task.id, false))!;
    assert.ok(run, "it runs");
    assert.equal(run_node(run, "changed").port, "yes");
    assert.equal(run_node(run, "review").state, "running");
    const reviewer = thread_of(s, run.id, "review");
    assert.ok(is_workflow(reviewer) && reviewer.parent_id === task.id);
    let asked = last_user_text(s, reviewer.id);
    assert.ok(asked.includes('You are "Reviewer", a step of the workflow "Review", for task X-1') && asked.includes("call `submit_review` once"), asked);
    let r = db.latest_run(s.db(), reviewer.id, null)!;
    submit(s, reviewer, r, { verdict: "needs_fixes", summary: "One bug.", serious_issues: ["the bug"] });
    await end(s, run.id, "review", "Ok");
    let done = get_run(s.db(), run.id)!;
    assert.deepEqual([done.state, run_node(done, "fix").port, run_node(done, "summary").state], ["done", "sent", "skipped"]);
    assert.equal(done.rounds.fix, 1);
    const sent = last_user_text(s, task.id);
    assert.ok(sent.includes('The workflow "Review" found a serious issue') && sent.includes("1. the bug"), sent);

    // The agent's run (which the send started) ends: round 2 finds the issue again, and with no rounds left the task
    // is left for the user. (Its run fails to start in tests: let that end first.)
    await sleep(200);
    s.runs.delete(task.id);
    db.update_task(s.db(), task.id, [
      ["running", false],
      ["status", "in_review"],
    ]);
    run = (await start(s, w.id, task.id, false))!;
    assert.ok(run, "the agent worked since, so it changed");
    const reviewer2 = thread_of(s, run.id, "review");
    assert.equal(reviewer2.id, reviewer.id, "the step keeps its thread");
    assert.ok(last_user_text(s, reviewer.id).includes("Check that they're fixed:\n\n- the bug"));
    r = db.latest_run(s.db(), reviewer.id, null)!;
    submit(s, reviewer, r, { verdict: "needs_fixes", serious_issues: ["the bug"] });
    await end(s, run.id, "review", "Ok");
    done = get_run(s.db(), run.id)!;
    assert.equal(run_node(done, "fix").port, "exhausted");
    let t = db.get_task(s.db(), task.id)!;
    assert.equal(t.status, "needs_attention");
    assert.ok((t.attention_reason ?? "").includes("after a round of fixes"));

    // Run by hand, with fresh rounds: it passes, and the summary is written.
    db.update_task(s.db(), task.id, [["status", "in_review"]]);
    run = (await start(s, w.id, task.id, true))!;
    assert.deepEqual(run.rounds, {});
    r = db.latest_run(s.db(), reviewer.id, null)!;
    submit(s, reviewer, r, { verdict: "pass", summary: "Good." });
    await end(s, run.id, "review", "Ok");
    const summarizer = thread_of(s, run.id, "summary");
    asked = last_user_text(s, summarizer.id);
    assert.ok(asked.includes("Summarise X-1.") && asked.includes('The step "Reviewer" before you said:\n\n> Good.') && !asked.includes("submit_review"), asked);
    // A text step can't submit a verdict.
    r = db.latest_run(s.db(), summarizer.id, null)!;
    assert.throws(() => submit(s, summarizer, r, { verdict: "pass" }));
    s.add_message(summarizer.id, "claude", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It fixes the thing." }] } });
    await end(s, run.id, "summary", "Ok");
    done = get_run(s.db(), run.id)!;
    assert.equal(done.state, "done");
    assert.equal(run_node(done, "summary").text, "It fixes the thing.");
    assert.equal(run_node(done, "review").text, "Good.");

    // Nothing changed since: entering In review again doesn't review it again.
    run = (await start(s, w.id, task.id, false))!;
    assert.deepEqual([run.state, run_node(run, "changed").port, run_node(run, "review").state], ["done", "no", "skipped"]);
    t = db.get_task(s.db(), task.id)!;
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("the_agent_working_again_stops_the_run_and_its_steps", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    const w = make(s, project, review_graph());
    const run = (await start(s, w.id, task.id, false))!;
    const reviewer = thread_of(s, run.id, "review");
    assert.ok(s.is_running(reviewer.id));
    supersede(s, task);
    const stopped = get_run(s.db(), run.id)!;
    assert.deepEqual([stopped.state, run_node(stopped, "review").state, run_node(stopped, "fix").state], ["stopped", "stopped", "skipped"]);
    // Its late verdict and end don't count.
    const r = db.latest_run(s.db(), reviewer.id, null)!;
    assert.throws(() => submit(s, reviewer, r, { verdict: "pass" }));
    finished(s, reviewer, r, "Cancelled", null);
    assert.equal(run_node(get_run(s.db(), run.id)!, "review").state, "stopped");
    // A stopped run doesn't count as one that finished: the next one reviews.
    s.runs.delete(reviewer.id);
    const again = (await start(s, w.id, task.id, false))!;
    assert.equal(run_node(again, "changed").port, "yes");
    assert.ok(stop(s, task.id));
    assert.ok(!stop(s, task.id));
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_workflow_starts_when_its_task_enters_its_column_and_not_when_it_moves_it_there", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  // Entering In review moves the task to To do, which a second workflow picks up.
  const first = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "status", status: "in_review" },
      { id: "m", kind: "set_status", status: "todo" },
    ],
    edges: [{ from: "t", port: "out", to: "m" }],
  });
  const second = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "status", status: "todo" },
      { id: "m", kind: "set_status", status: "backlog" },
    ],
    edges: [{ from: "t", port: "out", to: "m" }],
  });
  // Off: it doesn't start by itself.
  update(s, second.id, { enabled: false });
  on_status(s, task);
  await until(() => db.get_task(s.db(), task.id)!.status === "todo");
  await sleep(100);
  assert.equal(db.get_task(s.db(), task.id)!.status, "todo");
  assert.equal(latest_run(s.db(), first.id, task.id)!.state, "done");
  assert.equal(latest_run(s.db(), second.id, task.id), null);
  // Moving it back into In review by hand starts the first again.
  await api.update_task_inner(s, task.id, { status: "in_review" });
  await until(() => db.get_task(s.db(), task.id)!.status === "todo");
  assert.equal(db.get_task(s.db(), task.id)!.status, "todo");
  // Deleting a workflow takes its runs with it.
  delete_(s, first.id);
  assert.equal(latest_run(s.db(), first.id, task.id), null);
});

// HA-262: a merge approved or denied on its card didn't start the workflows of the column that moved the task to.
test("deciding_a_merge_starts_the_workflows_of_the_column_it_moves_the_task_to", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "status", status: "in_review" },
      { id: "c", kind: "condition", check: "has_pr" },
    ],
    edges: [{ from: "t", port: "out", to: "c" }],
  });
  // Its summary run has ended, and the card waits for the user's answer.
  db.update_task(s.db(), task.id, [
    ["status", "needs_attention"],
    ["merging", true],
    ["merge_approval", "pending"],
  ]);
  assert.equal(merge_gate.decide(s, task.id, false).status, "in_review");
  await until(() => latest_run(s.db(), w.id, task.id) != null);
  assert.equal(latest_run(s.db(), w.id, task.id)?.state, "done");
});

test("an_edge_into_a_column_moves_the_task_and_the_next_run_starts_from_there", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  db.update_task(s.db(), task.id, [["status", "backlog"]]);
  const w = make(s, project, {
    nodes: [
      { id: "todo", kind: "column", status: "todo" },
      { id: "review", kind: "column", status: "in_review" },
      { id: "has_pr", kind: "condition", check: "has_pr" },
    ],
    edges: [
      { from: "todo", port: "done", to: "review" },
      { from: "review", port: "done", to: "has_pr" },
    ],
  });
  await api.update_task_inner(s, task.id, { status: "todo" });
  const count = () => Number(db.value(s.db(), "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?1", w.id));
  await until(() => db.get_task(s.db(), task.id)!.status === "in_review" && count() === 2 && latest_run(s.db(), w.id, task.id)?.state === "done");
  const runs = db.all(s.db(), "SELECT * FROM workflow_runs WHERE workflow_id=?1 ORDER BY rowid", w.id).map((r: any) => JSON.parse(r.nodes));
  assert.equal(runs.length, 2);
  // The first ends at In review, which it moved the task to; the second starts there and goes on.
  assert.deepEqual([runs[0].todo.start, runs[0].review.state, runs[0].review.port, runs[0].has_pr.state], [true, "done", undefined, "skipped"]);
  assert.deepEqual([runs[1].review.start, runs[1].has_pr.port, runs[1].todo.state], [true, "no", "skipped"]);
});

test("a_restart_fails_the_steps_the_board_was_running_and_goes_on", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "m", kind: "set_status", status: "todo" },
      { id: "after", kind: "set_status", status: "backlog" },
      { id: "if_failed", kind: "set_status", status: "needs_attention" },
    ],
    edges: [
      { from: "t", port: "out", to: "m" },
      { from: "m", port: "out", to: "after" },
    ],
  });
  // A run whose move step was running when the server stopped.
  const run = bare_run(w.graph, task.id, null);
  Object.assign(run, { id: "run1", workflow_id: w.id });
  run.nodes = { t: { state: "done", port: "out" }, m: { state: "running" }, after: { state: "pending" }, if_failed: { state: "pending" } };
  insert_run(s.db(), run);
  resume(s);
  await until(() => get_run(s.db(), "run1")!.state !== "running");
  const done = get_run(s.db(), "run1")!;
  assert.equal(done.state, "done");
  assert.deepEqual([run_node(done, "m").state, run_node(done, "m").port], ["failed", "failed"]);
  assert.match(run_node(done, "m").text ?? "", /Interrupted/);
  assert.equal(run_node(done, "after").state, "skipped");
  assert.equal(db.get_task(s.db(), task.id)!.status, "in_review", "the interrupted move isn't made");
});

test("runs_carry_their_rounds_and_api_json_leaves_out_task_run", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "m", kind: "set_status", status: "todo" },
    ],
    edges: [{ from: "t", port: "out", to: "m" }],
  });
  const run = (await start(s, w.id, task.id, true))!;
  const { run_json } = await import("./handlers.ts");
  const v = JSON.parse(JSON.stringify(run_json(s.db(), run)));
  assert.equal(v.workflow_name, "Review");
  assert.ok(!("task_run" in v), "serde skips task_run");
  assert.deepEqual(Object.keys(v.nodes), ["m", "t"], "nodes are kept in order, as a BTreeMap");
});

// ---------- HA-229's ----------

test("a_restart_fails_agent_steps_whose_agent_never_started_and_leaves_those_running", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "a", kind: "agent", name: "A", output: "text" },
      { id: "b", kind: "agent", name: "B", output: "text" },
      { id: "c", kind: "agent", name: "C", output: "text" },
    ],
    edges: [
      { from: "t", port: "out", to: "a" },
      { from: "t", port: "out", to: "b" },
      { from: "t", port: "out", to: "c" },
    ],
  });
  const thread = (title: string) =>
    db.insert_task(s.db(), {
      profile_id: task.profile_id,
      project_id: project.id,
      kind: "review",
      title,
      description: "",
      status: "todo",
      use_worktree: false,
      model: null,
      effort: null,
      claude_config_id: null,
    });
  const working = thread("working");
  const idle = thread("idle");
  // `a` was marked running, but the server stopped while it read the task's git, before it had a thread; `b`'s thread
  // never got its run; `c`'s agent is working (runner.load_active has it), and carries on.
  const run = bare_run(w.graph, task.id, null);
  Object.assign(run, { id: "run1", workflow_id: w.id });
  run.nodes = {
    t: { state: "done", port: "out" },
    a: { state: "running" },
    b: { state: "running", thread_id: idle.id, after_run: "" },
    c: { state: "running", thread_id: working.id, after_run: "" },
  };
  insert_run(s.db(), run);
  s.runs.set(working.id, { run_id: "x", cancel: null } as any);
  resume(s);
  await sleep(50);
  const r = get_run(s.db(), "run1")!;
  assert.equal(r.state, "running", "c's agent is still working");
  assert.deepEqual([run_node(r, "a").state, run_node(r, "b").state, run_node(r, "c").state], ["failed", "failed", "running"]);
  assert.match(run_node(r, "a").text ?? "", /Interrupted/);
  // Once c's agent is gone too (a second restart), the run ends.
  s.runs.delete(working.id);
  resume(s);
  await until(() => get_run(s.db(), "run1")!.state !== "running");
  assert.equal(get_run(s.db(), "run1")!.state, "done");
});

test("a_workflow_that_moves_a_task_from_column_to_column_and_back_stops_after_a_few_runs_in_a_row", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "review", kind: "column", status: "in_review" },
      { id: "todo", kind: "column", status: "todo" },
    ],
    edges: [
      { from: "review", port: "done", to: "todo" },
      { from: "todo", port: "done", to: "review" },
    ],
  });
  const count = () => Number(db.value(s.db(), "SELECT COUNT(*) FROM workflow_runs WHERE task_id=?1", task.id));
  const warned = () => testing.messages(s.db(), task.id).some((m: any) => m.kind === "event" && /moved the task \d+ times in a row/.test(m.data?.text ?? ""));
  on_status(s, task);
  await until(warned, 5000);
  assert.ok(warned(), "it says why it stopped");
  await sleep(200);
  assert.equal(count(), MAX_CHAIN, "runs in a row, counting the first");
  assert.equal(latest_run(s.db(), w.id, task.id)!.state, "done");
  // Moving the task by hand starts a chain of its own.
  const status = db.get_task(s.db(), task.id)!.status;
  await api.update_task_inner(s, task.id, { status: status === "todo" ? "in_review" : "todo" });
  await until(() => count() === 2 * MAX_CHAIN, 5000);
  await sleep(200);
  assert.equal(count(), 2 * MAX_CHAIN);
});

test("an_agent_steps_effort_and_model_are_checked", () => {
  const s = testing.state();
  const [project] = setup(s);
  const graph = (o: any) => ({
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "a", kind: "agent", name: "A", output: "text", ...o },
    ],
    edges: [{ from: "t", port: "out", to: "a" }],
  });
  for (const bad of [{ effort: "extreme" }, { model: "--dangerously-skip-permissions" }, { model: "opus plus" }, { model: "x".repeat(101) }]) {
    assert.throws(() => check_graph(s.db(), project, graph(bad)), ApiErrorLike, JSON.stringify(bad));
  }
  const g = check_graph(s.db(), project, graph({ effort: " high ", model: " claude-opus-5-5[1m] " }));
  const a: any = g.nodes.find((n) => n.id === "a");
  assert.deepEqual([a.effort, a.model], ["high", "claude-opus-5-5[1m]"]);
  const blank: any = check_graph(s.db(), project, graph({ effort: " ", model: "" })).nodes.find((n) => n.id === "a");
  assert.ok(!("effort" in blank) && !("model" in blank));
});

/** An ApiError (400) thrown by check_graph. */
function ApiErrorLike(e: any): boolean {
  return e?.status === 400;
}

// HA-276: a workflow that starts when the task's agent finishes, a pull request step, and steps fed by those before them.

/** Ends a run of the task's agent as a finished one: the task was in progress. */
function agent_finishes(s: AppState, task: Task) {
  const r = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", r.id);
  s.update_task(task.id, [
    ["status", "in_progress"],
    ["running", true],
  ]);
  finish(s, r.id, "Ok");
}

test("the_new_nodes_are_checked", () => {
  const s = testing.state();
  const [project] = setup(s);
  const g = check_graph(s.db(), project, {
    nodes: [
      { id: "t", kind: "trigger", on: "finished", status: "in_review" },
      { id: "pr", kind: "open_pr", title: " {{task.key}} ", draft: true },
      { id: "a", kind: "agent", name: "A", input_only: true },
    ],
    edges: [
      { from: "t", port: "out", to: "pr" },
      { from: "pr", port: "opened", to: "a" },
      { from: "pr", port: "exists", to: "a" },
    ],
  });
  // A start on the agent finishing, from before column nodes, is In progress's node, and its `out` is `done`.
  assert.deepEqual(g.nodes[0], { id: "t", kind: "column", status: "in_progress", prompt: "", x: 0, y: 0 });
  assert.deepEqual(g.edges[0], { from: "t", port: "done", to: "pr" });
  assert.deepEqual(g.nodes[1], { id: "pr", kind: "open_pr", title: "{{task.key}}", body: "", draft: true, x: 0, y: 0 });
  assert.equal((g.nodes[2] as any).input_only, true);
  const plain: any = check_graph(s.db(), project, {
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "a", kind: "agent", name: "A" },
    ],
    edges: [],
  });
  assert.ok(!("input_only" in plain.nodes[1]));
  assert.throws(
    () =>
      check_graph(s.db(), project, {
        nodes: [
          { id: "t", kind: "trigger", on: "manual" },
          { id: "pr", kind: "open_pr" },
        ],
        edges: [{ from: "pr", port: "out", to: "t" }],
      }),
    ApiErrorLike,
  );
});

test("a_finished_workflow_holds_the_task_in_progress_and_moves_it_on", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  // Without one, the agent's finished run goes to In review.
  agent_finishes(s, task);
  assert.equal(db.get_task(s.db(), task.id)!.status, "in_review");
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "finished" },
      { id: "c", kind: "condition", check: "label", value: "plan" },
      { id: "m", kind: "set_status", status: "backlog" },
    ],
    edges: [
      { from: "t", port: "out", to: "c" },
      { from: "c", port: "no", to: "m" },
    ],
  });
  db.update_task(s.db(), task.id, [["status", "in_progress"]]);
  agent_finishes(s, task);
  await until(() => db.get_task(s.db(), task.id)!.status === "backlog" && latest_run(s.db(), w.id, task.id)?.state === "done");
  // (Moving it to Backlog starts a run at its node there too.)
  const run = finished_run(s, w.id);
  assert.equal(run.source, "finished");
  // Off, it leaves the agent's run to go to In review as before.
  update(s, w.id, { enabled: false });
  agent_finishes(s, task);
  assert.equal(db.get_task(s.db(), task.id)!.status, "in_review");
  // Its In progress node doesn't start when the task enters In progress, only when its agent's work is done.
  update(s, w.id, { enabled: true });
  db.update_task(s.db(), task.id, [["status", "todo"]]);
  await api.update_task_inner(s, task.id, { status: "in_progress" });
  await sleep(100);
  assert.equal(latest_run(s.db(), w.id, task.id)!.id, run.id);
});

test("an_agent_step_gets_only_the_output_of_the_steps_before_it", async () => {
  // Which steps those are: those with a path to it, whatever is in between.
  const g = Graph_from_json({
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "a", kind: "agent", name: "A" },
      { id: "side", kind: "agent", name: "Aside" },
      { id: "c", kind: "condition", check: "has_pr" },
      { id: "b", kind: "agent", name: "B" },
    ],
    edges: [
      { from: "t", port: "out", to: "a" },
      { from: "t", port: "out", to: "side" },
      { from: "a", port: "done", to: "c" },
      { from: "c", port: "no", to: "b" },
    ],
  });
  assert.deepEqual(
    upstream(g, "b").map((n) => n.id),
    ["a"],
  );
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    const w = make(s, project, {
      nodes: [
        { id: "t", kind: "trigger", on: "manual" },
        { id: "summary", kind: "agent", name: "Summary", prompt: "Summarise it." },
        { id: "post", kind: "agent", name: "Post", prompt: "Turn it into a post.", skills: ["tldr"], input_only: true },
      ],
      edges: [
        { from: "t", port: "out", to: "summary" },
        { from: "summary", port: "done", to: "post" },
      ],
    });
    const run = (await start(s, w.id, task.id, true))!;
    const t = thread_of(s, run.id, "summary");
    s.add_message(t.id, "claude", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It fixes the thing." }] } });
    await end(s, run.id, "summary", "Ok");
    const asked = last_user_text(s, thread_of(s, run.id, "post").id);
    assert.ok(asked.includes('The step "Summary" before you said:\n\n> It fixes the thing.'), asked);
    assert.ok(asked.includes("Turn it into a post.") && asked.includes("`/tldr`"), asked);
    assert.ok(!asked.includes("checked out in your working directory") && !asked.includes("Make it work."), "an input-only step isn't told about the work");
    // One that isn't is.
    assert.ok(last_user_text(s, t.id).includes("checked out in your working directory"));
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_pull_request_step_pushes_the_branch_and_opens_it", async () => {
  const s = testing.state();
  const [project, task, dir] = setup(s);
  const remote = testing.temp_dir();
  git(remote, ["init", "-q", "--bare"]);
  git(dir, ["remote", "add", "origin", remote]);
  const bin = testing.temp_dir();
  const gh = join(bin, "gh");
  const log = join(bin, "log");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\necho https://github.com/o/r/pull/7\n`);
  chmodSync(gh, 0o755);
  gh_mcp.TEST_GH_PROGRAM.set(gh);
  engine_testing.GITHUB = { remote: "origin", repo: "o/r" };
  try {
    s.add_message(task.id, "claude", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed the thing." }] } });
    const w = make(s, project, {
      nodes: [
        { id: "t", kind: "trigger", on: "manual" },
        { id: "pr", kind: "open_pr", title: "{{task.key}}: {{task.title}}", draft: true },
        { id: "m", kind: "set_status", status: "in_review" },
      ],
      edges: [
        { from: "t", port: "out", to: "pr" },
        { from: "pr", port: "opened", to: "m" },
        { from: "pr", port: "exists", to: "m" },
      ],
    });
    db.update_task(s.db(), task.id, [["status", "in_progress"]]);
    const run = (await start(s, w.id, task.id, true))!;
    assert.deepEqual([run_node(run, "pr").state, run_node(run, "pr").port, run_node(run, "pr").text], ["done", "opened", "https://github.com/o/r/pull/7"]);
    const t = db.get_task(s.db(), task.id)!;
    assert.deepEqual([t.pr_url, t.status], ["https://github.com/o/r/pull/7", "in_review"]);
    const args = readFileSync(log, "utf8").split("\n");
    for (const a of ["pr", "create", "--title=X-1: Fix the thing", "--body=Fixed the thing.", "--base=master", "--head=ia/x-1", "--draft"]) {
      assert.ok(args.includes(a), `${a} in ${JSON.stringify(args)}`);
    }
    execFileSync("git", ["-C", remote, "rev-parse", "--verify", "refs/heads/ia/x-1"]);
    // Once it has one, the step finds it.
    const again = (await start(s, w.id, task.id, true))!;
    assert.equal(run_node(again, "pr").port, "exists");
    // A branch without commits of its own has nothing to open one for.
    db.update_task(s.db(), task.id, [["pr_url", null]]);
    git(dir, ["checkout", "-q", "master"]);
    db.update_task(s.db(), task.id, [["branch", "master"]]);
    const none = (await start(s, w.id, task.id, true))!;
    assert.equal(run_node(none, "pr").port, "failed");
    assert.ok((run_node(none, "pr").text ?? "").includes("no commits of its own"), run_node(none, "pr").text);
    // Moved to Needs attention, the task says why.
    const graph = {
      nodes: [
        { id: "t", kind: "trigger", on: "manual" },
        { id: "pr", kind: "open_pr" },
        { id: "m", kind: "set_status", status: "needs_attention" },
      ],
      edges: [
        { from: "t", port: "out", to: "pr" },
        { from: "pr", port: "failed", to: "m" },
      ],
    };
    update(s, w.id, { graph });
    await start(s, w.id, task.id, true);
    const flagged = db.get_task(s.db(), task.id)!;
    assert.equal(flagged.status, "needs_attention");
    assert.ok(
      (flagged.attention_reason ?? "").startsWith('The workflow "Review" failed at Open a pull request: the task\'s branch has no commits'),
      flagged.attention_reason ?? "",
    );
  } finally {
    gh_mcp.TEST_GH_PROGRAM.set(null);
    engine_testing.GITHUB = null;
  }
});

/** The "Open a PR when done" preset's graph (apps/web's settings/Workflows.tsx). */
function pr_when_done(): any {
  return {
    nodes: [
      { id: "start", kind: "trigger", on: "finished" },
      { id: "commits", kind: "condition", check: "has_commits" },
      { id: "pr", kind: "open_pr" },
      { id: "review", kind: "set_status", status: "in_review" },
      { id: "attention", kind: "set_status", status: "needs_attention" },
    ],
    edges: [
      { from: "start", port: "out", to: "commits" },
      { from: "commits", port: "yes", to: "pr" },
      { from: "commits", port: "no", to: "review" },
      { from: "pr", port: "opened", to: "review" },
      { from: "pr", port: "exists", to: "review" },
      { from: "pr", port: "failed", to: "attention" },
    ],
  };
}

/** Workflow `id`'s latest run that its task's agent finishing started. */
function finished_run(s: AppState, id: string): Run {
  return Run_from_row(db.one(s.db(), "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND source='finished' ORDER BY rowid DESC LIMIT 1", id));
}

async function left_in_progress(s: AppState, task_id: string): Promise<Task> {
  await until(() => db.get_task(s.db(), task_id)!.status !== "in_progress");
  return db.get_task(s.db(), task_id)!;
}

// Review of HA-276: a task without a worktree stayed in In progress, idle, as the preset's check failed and skipped the rest.
test("a_task_without_a_worktree_goes_to_review_with_the_pull_request_preset", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  db.update_task(s.db(), task.id, [
    ["worktree_path", null],
    ["worktree_state", "none"],
    ["branch", null],
  ]);
  const w = make(s, project, pr_when_done());
  agent_finishes(s, task);
  const t = await left_in_progress(s, task.id);
  // The run its agent finishing started (moving the task to In review starts one there too).
  const run = finished_run(s, w.id);
  assert.deepEqual([run_node(run, "commits").port, run_node(run, "pr").state], ["no", "skipped"]);
  assert.deepEqual([t.status, t.running], ["in_review", false]);
});

test("a_finished_run_that_leaves_the_task_where_it_was_moves_it_on", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  // An agent step that can't start (no agents here), with nothing after its failure: Needs attention, saying why.
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "finished" },
      { id: "a", kind: "agent", name: "Notes" },
      { id: "m", kind: "set_status", status: "in_review" },
    ],
    edges: [
      { from: "t", port: "out", to: "a" },
      { from: "a", port: "done", to: "m" },
    ],
  });
  agent_finishes(s, task);
  let t = await left_in_progress(s, task.id);
  assert.equal(t.status, "needs_attention");
  assert.ok((t.attention_reason ?? "").startsWith('The workflow "Review" failed at Notes: '), t.attention_reason ?? "");
  // One that ends without a move, and without failing: In review, as without it.
  update(s, w.id, {
    graph: {
      nodes: [
        { id: "t", kind: "trigger", on: "finished" },
        { id: "c", kind: "condition", check: "has_pr" },
      ],
      edges: [{ from: "t", port: "out", to: "c" }],
    },
  });
  agent_finishes(s, task);
  t = await left_in_progress(s, task.id);
  assert.deepEqual([t.status, t.attention_reason], ["in_review", null]);
});

test("a_stopped_finished_run_moves_the_task_on_unless_its_agent_started_again", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    const graph = {
      nodes: [
        { id: "t", kind: "trigger", on: "finished" },
        { id: "a", kind: "agent", name: "Notes" },
        { id: "m", kind: "set_status", status: "in_review" },
      ],
      edges: [
        { from: "t", port: "out", to: "a" },
        { from: "a", port: "done", to: "m" },
      ],
    };
    const w = make(s, project, graph);
    db.update_task(s.db(), task.id, [["status", "in_progress"]]);
    // Started as its agent's finishing starts it (rather than through finish, whose step would end first here).
    let run = (await start(s, w.id, task.id, false, 0, "finished"))!;
    assert.equal(run_node(run, "a").state, "running");
    // Its agent starts again: the task is its run's, and stays where it is.
    db.insert_run(s.db(), task.id, "prompt");
    supersede(s, task);
    await sleep(100);
    assert.equal(get_run(s.db(), run.id)!.state, "stopped");
    assert.equal(db.get_task(s.db(), task.id)!.status, "in_progress");
    // Stopped by the user: Needs attention.
    s.runs.delete(thread_of(s, run.id, "a").id);
    const r = db.insert_run(s.db(), task.id, "prompt");
    db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", r.id);
    run = (await start(s, w.id, task.id, false, 0, "finished"))!;
    assert.ok(run && run.state === "running", "a new run");
    assert.ok(stop(s, task.id));
    const t = await left_in_progress(s, task.id);
    assert.equal(t.status, "needs_attention");
    assert.ok((t.attention_reason ?? "").startsWith('The workflow "Review" was stopped before it moved the task'), t.attention_reason ?? "");
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

/** A whole task's way across the board, as column nodes: work, a pull request, review (sending its issues back), merge. */
function lifecycle(o: { work?: any; review?: any; merge?: any } = {}): any {
  return {
    nodes: [
      { id: "work", kind: "column", status: "in_progress", prompt: "Build {{task.title}}.", ...o.work },
      { id: "pr", kind: "open_pr" },
      { id: "review", kind: "column", status: "in_review", ...o.review },
      { id: "reviewer", kind: "agent", name: "Reviewer", output: "verdict" },
      { id: "merge", kind: "column", status: "ready_for_merge", prompt: "Squash it into {{task.key}}.", ...o.merge },
    ],
    edges: [
      { from: "work", port: "done", to: "pr" },
      { from: "pr", port: "opened", to: "review" },
      { from: "pr", port: "exists", to: "review" },
      { from: "review", port: "done", to: "reviewer" },
      { from: "reviewer", port: "issues", to: "work" },
      { from: "reviewer", port: "pass", to: "merge" },
    ],
  };
}

test("a_column_prompt_is_the_start_prompt_and_says_what_the_board_does_next", () => {
  const s = testing.state();
  const [project, task] = setup(s);
  assert.equal(start_instructions(s, task, project), null, "without a workflow, the project's start prompt");
  const w = make(s, project, lifecycle());
  const text = start_instructions(s, task, project)!;
  assert.ok(text.startsWith("Build Fix the thing."), text);
  assert.ok(text.includes("end your turn with a summary of what you did. The board then pushes your branch and opens its pull request"), text);
  assert.ok(text.includes("and moves the task to In review."), text);
  assert.ok(board_opens_pr(s, task), "the agent isn't told to open it");
  assert.equal(merge_instructions(s, task), "Squash it into X-1.");
  // A blank prompt is the project's start prompt; waiting for finish_work says how.
  update(s, w.id, { graph: lifecycle({ work: { prompt: "", done_when: "finish" } }) });
  const blank = start_instructions(s, task, project)!;
  assert.ok(
    blank.startsWith(`${project.start_prompt ?? "Start working on this task."}\n\nWhen the work you were asked for here is complete, call \`finish_work\``),
    blank,
  );
  // Off, it's the project's again.
  update(s, w.id, { enabled: false });
  assert.deepEqual([start_instructions(s, task, project), merge_instructions(s, task), board_opens_pr(s, task)], [null, null, false]);
});

test("a_column_with_the_agents_work_belongs_to_one_workflow_thats_on", () => {
  const s = testing.state();
  const [project] = setup(s);
  make(s, project, lifecycle());
  const clash = (g: any) =>
    assert.throws(
      () => make(s, project, g),
      (e: any) => e.status === 409 && e.message.includes("has the column"),
    );
  clash({ nodes: [{ id: "w", kind: "column", status: "in_progress" }], edges: [] });
  clash({ nodes: [{ id: "w", kind: "column", status: "in_review", prompt: "Check CI." }], edges: [] });
  // A column only entered (no prompt) is fine in two.
  const other = make(s, project, { nodes: [{ id: "v", kind: "column", status: "in_review" }], edges: [] });
  // Off, it may have one; turning it on checks again.
  const off = create(s, project.id, { name: "Off", enabled: false, graph: { nodes: [{ id: "w", kind: "column", status: "in_progress" }], edges: [] } });
  assert.throws(
    () => update(s, off.id, { enabled: true }),
    (e: any) => e.status === 409,
  );
  assert.ok(other.enabled);
});

test("a_finish_work_column_needs_attention_when_the_agent_doesnt_say_its_done", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "work", kind: "column", status: "in_progress", done_when: "finish" },
      { id: "out", kind: "column", status: "backlog" },
    ],
    edges: [{ from: "work", port: "done", to: "out" }],
  });
  agent_finishes(s, task);
  let t = db.get_task(s.db(), task.id)!;
  assert.deepEqual(
    [t.status, t.attention_reason],
    ["needs_attention", "The agent ended its turn without saying its work in In progress is done (with finish_work)"],
  );
  assert.equal(latest_run(s.db(), w.id, task.id), null);
  // It says so with the tool: the run's flag, which a new turn clears.
  const r = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", r.id);
  s.update_task(task.id, [
    ["status", "in_progress"],
    ["running", true],
  ]);
  assert.deepEqual(await handle_mcp(s, { run_id: r.id, call_id: "c1", tool: "finish_work", args: {}, task_fields: true }), {
    ok: true,
    note: "Recorded that the work is done. End your turn now with a summary of what you did.",
  });
  finish(s, r.id, "Ok");
  t = await left_in_progress(s, task.id);
  assert.equal(t.status, "backlog");
});

test("a_column_with_a_prompt_sends_it_and_waits_for_the_agents_work_there", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    db.update_task(s.db(), task.id, [
      ["status", "todo"],
      ["session_id", "sess"],
    ]);
    const w = make(s, project, {
      nodes: [
        { id: "ci", kind: "column", status: "in_review", prompt: "Check the CI of {{branch}}." },
        { id: "out", kind: "column", status: "backlog" },
      ],
      edges: [{ from: "ci", port: "done", to: "out" }],
    });
    await api.update_task_inner(s, task.id, { status: "in_review" });
    await until(() => latest_run(s.db(), w.id, task.id) != null);
    const waiting = latest_run(s.db(), w.id, task.id)!;
    assert.deepEqual([waiting.state, run_node(waiting, "ci").state], ["running", "running"]);
    assert.equal(
      last_user_text(s, task.id),
      "Check the CI of ia/x-1.\n\nWhen you're done, end your turn with a summary of what you did. The board then moves the task to Backlog.",
    );
    // Its agent starting (on the prompt) leaves it waiting; the launch fails here, which needs attention: still waiting.
    await until(() => !s.is_running(task.id) && !db.get_task(s.db(), task.id)!.running);
    assert.equal(get_run(s.db(), waiting.id)!.state, "running");
    // The user answers, and the agent's work is done: the run goes on from the column.
    agent_finishes(s, task);
    const t = await left_in_progress(s, task.id);
    assert.equal(t.status, "backlog");
    await until(() => get_run(s.db(), waiting.id)!.state === "done");
    const run = get_run(s.db(), waiting.id)!;
    assert.deepEqual([run.state, run.source, run_node(run, "ci").port, run_node(run, "out").state], ["done", "finished", "done", "done"]);
    // Moved out of the column it waits at, it stops waiting.
    db.update_task(s.db(), task.id, [["status", "todo"]]);
    await api.update_task_inner(s, task.id, { status: "in_review" });
    const waits = () => db.one(s.db(), "SELECT id FROM workflow_runs WHERE workflow_id=?1 AND state='running'", w.id)?.id as string | undefined;
    await until(() => waits() != null);
    const again = waits()!;
    await until(() => !s.is_running(task.id) && !db.get_task(s.db(), task.id)!.running);
    await api.update_task_inner(s, task.id, { status: "todo" });
    assert.deepEqual([get_run(s.db(), again)!.state, get_run(s.db(), again)!.detail], ["stopped", "Stopped because the task left In review."]);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_column_whose_work_ends_with_nothing_after_it_goes_to_review_without_starting_again", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    db.update_task(s.db(), task.id, [
      ["status", "todo"],
      ["session_id", "sess"],
    ]);
    const w = make(s, project, { nodes: [{ id: "ci", kind: "column", status: "in_review", prompt: "Check the CI." }], edges: [] });
    await api.update_task_inner(s, task.id, { status: "in_review" });
    await until(() => latest_run(s.db(), w.id, task.id) != null);
    await until(() => !s.is_running(task.id) && !db.get_task(s.db(), task.id)!.running);
    agent_finishes(s, task);
    const t = await left_in_progress(s, task.id);
    assert.equal(t.status, "in_review");
    await sleep(200);
    // Back in In review, whose work just ended: not sent the prompt again.
    assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?1", w.id), 1);
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("an_edge_into_in_progress_gives_the_agent_the_issues_found_or_the_columns_prompt", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    db.update_task(s.db(), task.id, [["session_id", "sess"]]);
    const w = make(s, project, {
      nodes: [
        { id: "review", kind: "column", status: "in_review" },
        { id: "has_pr", kind: "condition", check: "has_pr" },
        { id: "work", kind: "column", status: "in_progress", prompt: "Open a PR for {{task.key}} after all." },
      ],
      edges: [
        { from: "review", port: "done", to: "has_pr" },
        { from: "has_pr", port: "no", to: "work" },
      ],
    });
    const run = (await start(s, w.id, task.id, true))!;
    assert.deepEqual([run.state, run_node(run, "work").state], ["done", "done"]);
    assert.ok(last_user_text(s, task.id).startsWith("Open a PR for X-1 after all."), last_user_text(s, task.id));
    assert.equal(db.get_task(s.db(), task.id)!.status, "in_progress");
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

test("a_merge_goes_on_from_ready_for_merge", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "merge", kind: "column", status: "ready_for_merge" },
      { id: "c", kind: "condition", check: "has_pr" },
    ],
    edges: [{ from: "merge", port: "done", to: "c" }],
  });
  // Moved to Done without being merged: nothing.
  db.update_task(s.db(), task.id, [
    ["status", "done"],
    ["resolution", "wont_fix"],
  ]);
  on_status(s, db.get_task(s.db(), task.id)!);
  await sleep(100);
  assert.equal(latest_run(s.db(), w.id, task.id), null);
  db.update_task(s.db(), task.id, [["resolution", "done"]]);
  on_status(s, db.get_task(s.db(), task.id)!);
  await until(() => latest_run(s.db(), w.id, task.id)?.state === "done");
  const run = latest_run(s.db(), w.id, task.id)!;
  assert.deepEqual([run.source, run_node(run, "c").port], ["merged", "no"]);
});

test("old_starts_and_moves_are_read_as_column_nodes", () => {
  const g = Graph_from_json({
    nodes: [
      { id: "t", kind: "trigger", on: "status", status: "in_review" },
      { id: "m", kind: "set_status", status: "needs_attention" },
      { id: "h", kind: "trigger", on: "manual" },
    ],
    edges: [
      { from: "t", port: "out", to: "m" },
      { from: "h", port: "out", to: "m" },
    ],
  });
  assert.deepEqual(
    g.nodes.map((n: any) => [n.kind, n.status ?? n.on]),
    [
      ["column", "in_review"],
      ["column", "needs_attention"],
      ["trigger", "manual"],
    ],
  );
  assert.deepEqual(
    g.edges.map((e) => e.port),
    ["done", "out"],
  );
});

// Review of HA-276's column nodes: entering a column that's only where lines end made a run that skipped the review,
// which then hid the review's output in the task's tab, as did a run from In progress.
test("a_column_with_nothing_after_it_runs_nothing_and_tabs_keep_each_steps_last_output", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "review", kind: "column", status: "in_review" },
      { id: "reviewer", kind: "agent", name: "Reviewer", output: "verdict", tab: "Review" },
      { id: "attention", kind: "column", status: "needs_attention" },
    ],
    edges: [
      { from: "review", port: "done", to: "reviewer" },
      { from: "reviewer", port: "failed", to: "attention" },
    ],
  });
  await api.update_task_inner(s, task.id, { status: "needs_attention" });
  await sleep(100);
  assert.equal(latest_run(s.db(), w.id, task.id), null);
  // A run whose review ran, then a later one that skipped it.
  const at = (n: number) => new Date(Date.parse("2026-11-07T00:00:00Z") + n * 1000).toISOString();
  const run = (id: string, n: number, reviewer: any) => {
    const r = bare_run(w.graph, task.id, null);
    Object.assign(r, { id, workflow_id: w.id, state: "done", created_at: at(n), nodes: { review: { state: "done", port: "done" }, reviewer } });
    insert_run(s.db(), r);
  };
  run("reviewed", 1, { state: "done", port: "pass", text: "Looks good." });
  run("skipped", 2, { state: "skipped" });
  assert.deepEqual(
    latest_runs(s.db(), task.id).map((r) => r.id),
    ["skipped"],
  );
  assert.deepEqual(
    latest_runs(s.db(), task.id, true).map((r) => r.id),
    ["skipped", "reviewed"],
  );
});

// Review of HA-276's column nodes: a task held in In progress for a run that then didn't start stayed there, idle.
test("a_task_held_for_a_run_that_doesnt_start_goes_to_review", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  const w = make(s, project, {
    nodes: [
      { id: "work", kind: "column", status: "in_progress" },
      { id: "c", kind: "condition", check: "has_pr" },
    ],
    edges: [{ from: "work", port: "done", to: "c" }],
  });
  db.update_task(s.db(), task.id, [["status", "in_progress"]]);
  // It ran once for this run of the agent's already (as when a restart settles a plan task's column again).
  const r = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", r.id);
  assert.ok(await start(s, w.id, task.id, false, 0, "finished"));
  await left_in_progress(s, task.id);
  // Held again for the same run of the agent: the workflow doesn't run twice for it.
  db.update_task(s.db(), task.id, [["status", "in_progress"]]);
  on_finished(s, db.get_task(s.db(), task.id)!, on_finish_due(s, db.get_task(s.db(), task.id)!)!);
  await sleep(50);
  assert.equal(Number(db.value(s.db(), "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?1", w.id)), 1);
  const t = await left_in_progress(s, task.id);
  assert.equal(t.status, "in_review");
});

test("data_wires_go_from_a_value_to_an_input_one_each_and_never_round", () => {
  const s = testing.state();
  const [project] = setup(s);
  const c = s.db();
  const bad = (g: any, what: string) =>
    assert.throws(
      () => check_graph(c, project, g),
      (e: any) => e.status === 400 && e.message.includes(what),
    );
  const nodes = [
    { id: "work", kind: "column", status: "in_progress" },
    { id: "t", kind: "text", text: "Use TDD." },
    { id: "u", kind: "text", text: "Be brief." },
    { id: "c", kind: "compose", template: "{{a}} {{b}}" },
    { id: "d", kind: "compose", template: "{{x}}" },
  ];
  check_graph(c, project, {
    nodes,
    edges: [
      { from: "t", port: "text", to: "c", input: "a" },
      { from: "u", port: "text", to: "c", input: "b" },
      { from: "c", port: "text", to: "work", input: "prompt" },
    ],
  });
  bad({ nodes, edges: [{ from: "t", port: "nope", to: "c", input: "a" }] }, "gives no value nope");
  bad({ nodes, edges: [{ from: "t", port: "text", to: "c", input: "zz" }] }, "has no input zz");
  bad(
    {
      nodes,
      edges: [
        { from: "t", port: "text", to: "c", input: "a" },
        { from: "u", port: "text", to: "c", input: "a" },
      ],
    },
    "two wires",
  );
  bad({ nodes, edges: [{ from: "work", port: "done", to: "t" }] }, "gives values, so no run goes into it");
  bad({ nodes, edges: [{ from: "t", port: "done", to: "work" }] }, "has no port done");
  bad(
    {
      nodes,
      edges: [
        { from: "c", port: "text", to: "d", input: "x" },
        { from: "d", port: "text", to: "c", input: "a" },
      ],
    },
    "values go round in a loop",
  );
  // A step's value back into a step before it is no loop: it's read from its run, or an earlier one.
  check_graph(c, project, {
    nodes: [
      { id: "work", kind: "column", status: "in_progress" },
      { id: "r", kind: "agent", name: "R", output: "verdict" },
    ],
    edges: [
      { from: "work", port: "done", to: "r" },
      { from: "r", port: "issues", to: "work", input: "prompt" },
    ],
  });
});

test("a_prompt_built_from_wires_takes_the_task_the_last_review_and_the_note_where_its_put", () => {
  const s = testing.state();
  const [project, task] = setup(s);
  db.update_task(s.db(), task.id, [["labels", JSON.stringify(["plan"])]]);
  const graph = (o: { next?: boolean } = {}) => ({
    nodes: [
      { id: "work", kind: "column", status: "in_progress" },
      { id: "review", kind: "column", status: "in_review" },
      { id: "reviewer", kind: "agent", name: "Reviewer", output: "verdict" },
      { id: "task", kind: "task" },
      { id: "rules", kind: "text", text: "Rules for {{task.key}}." },
      { id: "base", kind: "project_prompt", which: "start" },
      { id: "plan", kind: "switch", check: "label", value: "plan" },
      { id: "planned", kind: "text", text: "Follow the plan." },
      { id: "join", kind: "join", separator: "\\n", count: 3 },
      { id: "compose", kind: "compose", template: "# {{title}}\n\n{{body}}\n\nFix: {{issues}}{{note}}" },
    ],
    edges: [
      { from: "work", port: "done", to: "review" },
      { from: "review", port: "done", to: "reviewer" },
      { from: "task", port: "title", to: "compose", input: "title" },
      { from: "base", port: "text", to: "join", input: "in1" },
      { from: "rules", port: "text", to: "join", input: "in2" },
      { from: "plan", port: "text", to: "join", input: "in3" },
      { from: "planned", port: "text", to: "plan", input: "yes" },
      { from: "join", port: "text", to: "compose", input: "body" },
      { from: "reviewer", port: "issues", to: "compose", input: "issues" },
      ...(o.next ? [{ from: "work", port: "next", to: "compose", input: "note" }] : []),
      { from: "compose", port: "text", to: "work", input: "prompt" },
    ],
  });
  const w = make(s, project, graph());
  // The last review found an issue.
  const r = bare_run(w.graph, task.id, null);
  Object.assign(r, {
    id: "earlier",
    workflow_id: w.id,
    state: "done",
    nodes: { review: { state: "done", port: "done", start: true }, reviewer: { state: "done", port: "issues", issues: ["It crashes."] } },
  });
  insert_run(s.db(), r);
  const t = db.get_task(s.db(), task.id)!;
  const note = "When you're done, end your turn with a summary of what you did. The board then moves the task to In review.";
  // {{note}} isn't wired: unwired, a name with no value of the template's own is left as it is.
  assert.equal(
    start_instructions(s, t, project),
    `# Fix the thing\n\nStart working on this task.\nRules for X-1.\nFollow the plan.\n\nFix: 1. It crashes.{{note}}\n\n${note}`,
  );
  // With `next` wired, the note is where it's put, and only there.
  update(s, w.id, { graph: graph({ next: true }) });
  assert.equal(
    start_instructions(s, t, project),
    `# Fix the thing\n\nStart working on this task.\nRules for X-1.\nFollow the plan.\n\nFix: 1. It crashes.${note}`,
  );
  // Without the label, the switch gives its no, which isn't wired: that line goes.
  db.update_task(s.db(), task.id, [["labels", "[]"]]);
  assert.ok(!start_instructions(s, db.get_task(s.db(), task.id)!, project)!.includes("Follow the plan."));
});

test("a_send_and_a_pull_request_take_their_wired_text", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    db.update_task(s.db(), task.id, [["session_id", "sess"]]);
    const w = make(s, project, {
      nodes: [
        { id: "start", kind: "trigger", on: "manual" },
        { id: "send", kind: "send_to_task", message: "unused", max_rounds: 2 },
        { id: "msg", kind: "compose", template: "Hello {{who}}, about {{task.key}}." },
        { id: "who", kind: "task" },
      ],
      edges: [
        { from: "start", port: "out", to: "send" },
        { from: "who", port: "title", to: "msg", input: "who" },
        { from: "msg", port: "text", to: "send", input: "message" },
      ],
    });
    const run = (await start(s, w.id, task.id, true))!;
    // Data nodes take no part in the run, which ends as it would without them.
    assert.deepEqual([run.state, Object.keys(run.nodes).sort()], ["done", ["send", "start"]]);
    assert.equal(last_user_text(s, task.id), "Hello Fix the thing, about X-1.");
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

// Review of HA-276: In progress's run, which moves the task to In review, skipped the send after the review and gave its
// round back, so the review and its fixes went round without end; and a check after In review compared with that run,
// where it hadn't run (as the review's recheck did), so it saw no change. The preset's shape, with a check in place of
// the reviewer (whose agent can't run here): In progress → In review → changed → no pull request → send, one round.
test("rounds of review and fixes through In progress end once they're used up", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    const w = make(s, project, {
      nodes: [
        { id: "work", kind: "column", status: "in_progress" },
        { id: "review", kind: "column", status: "in_review" },
        { id: "changed", kind: "condition", check: "changed" },
        { id: "has_pr", kind: "condition", check: "has_pr" },
        { id: "fix", kind: "send_to_task", message: "Open its pull request.", max_rounds: 1 },
      ],
      edges: [
        { from: "work", port: "done", to: "review" },
        { from: "review", port: "done", to: "changed" },
        { from: "changed", port: "yes", to: "has_pr" },
        { from: "has_pr", port: "no", to: "fix" },
      ],
    });
    // Round 1, from In review: sent to the agent.
    const r1 = (await start(s, w.id, task.id, false, 0, "status", "review"))!;
    assert.deepEqual([run_node(r1, "fix").port, r1.rounds], ["sent", { fix: 1 }]);
    // The agent works on it (its run fails to start in tests: let that end first), and its work in In progress is done.
    await until(() => !s.is_running(task.id) && !db.get_task(s.db(), task.id)!.running, 15000);
    assert.ok(!s.is_running(task.id), "the agent's launch has ended");
    db.run(s.db(), "UPDATE runs SET status='exited' WHERE task_id=?1", task.id);
    db.update_task(s.db(), task.id, [
      ["running", false],
      ["status", "in_progress"],
    ]);
    const r2 = (await start(s, w.id, task.id, false, 0, "finished", "work"))!;
    assert.deepEqual([r2.state, run_node(r2, "fix").state, r2.rounds], ["done", "skipped", { fix: 1 }], "the round is kept past In review");
    // In review again, which In progress's run moved it to: the check sees the agent's work since round 1 (not since
    // In progress's run), and with no round left the task needs attention.
    const latest = () => latest_run(s.db(), w.id, task.id);
    await until(() => latest()?.id !== r2.id && latest()?.state === "done", 15000);
    const r3 = latest()!;
    assert.notEqual(r3.id, r2.id, "round 2 ran");
    assert.deepEqual([run_node(r3, "changed").port, run_node(r3, "fix").port], ["yes", "exhausted"]);
    const t = db.get_task(s.db(), task.id)!;
    assert.equal(t.status, "needs_attention");
    assert.ok((t.attention_reason ?? "").includes("is out of rounds"), t.attention_reason ?? "");
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});

// Review of HA-276: done_when: finish held tasks to finish_work that they weren't told about: a scratch task (which
// doesn't get In progress's prompt), and the workflow's own fix messages; and a merge run was told not to push.
test("finish_work is asked of the runs that are told about it, and a merge pushes its own work", async () => {
  runs.TEST_CAN_RUN.set(true);
  try {
    const s = testing.state();
    const [project, task] = setup(s);
    make(s, project, {
      nodes: [
        { id: "work", kind: "column", status: "in_progress", done_when: "finish" },
        { id: "pr", kind: "open_pr" },
        { id: "start", kind: "trigger", on: "manual" },
        { id: "fix", kind: "send_to_task", message: "Fix the thing again.", max_rounds: 2 },
      ],
      edges: [
        { from: "work", port: "done", to: "pr" },
        { from: "start", port: "out", to: "fix" },
      ],
    });
    // A scratch task isn't told to call finish_work, so it isn't held to it: the workflow takes it on (whose pull
    // request fails here, with no GitHub remote).
    const scratch = db.update_task(s.db(), task.id, [["task_type", "scratch"]])!;
    agent_finishes(s, scratch);
    let t = await left_in_progress(s, task.id);
    assert.ok((t.attention_reason ?? "").startsWith('The workflow "Review" failed at Open a pull request'), t.attention_reason ?? "");
    // A code task's fix message ends saying how to finish, as its start prompt did.
    db.update_task(s.db(), task.id, [
      ["task_type", null],
      ["session_id", "sess"],
      ["status", "in_review"],
    ]);
    const w = db.all(s.db(), "SELECT id FROM workflows")[0].id as string;
    await start(s, w, task.id, true);
    const sent = last_user_text(s, task.id);
    assert.ok(sent.startsWith("Fix the thing again.\n\nWhen the work you were asked for here is complete, call `finish_work`"), sent);
    assert.ok(sent.includes("The board then pushes your branch and opens its pull request"), sent);
    // The board opens the pull request after In progress, so the agent isn't told to; but not when it merges.
    t = db.get_task(s.db(), task.id)!;
    assert.ok(board_opens_pr(s, { ...t, merging: false, remerge: false }));
    assert.ok(!board_opens_pr(s, { ...t, merging: true }));
    assert.ok(!board_opens_pr(s, { ...t, remerge: true }));
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
});
