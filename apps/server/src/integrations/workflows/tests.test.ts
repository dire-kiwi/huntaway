// The tests of server/src/integrations/workflows/tests.rs (HA-173's branch, ported by HA-189), and more of HA-189's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import * as api from "../../api.ts";
import * as runs from "../../agent/runs.ts";
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
  on_status,
  resume,
  run_node,
  start,
  stop,
  submit,
  supersede,
  finished,
  update,
  insert_run,
  type Run,
  type Workflow,
} from "../workflows.ts";
import { advance, plan, step_ended } from "./engine.ts";
import * as prompt from "./prompt.ts";

// As in Rust's tests, there's no ia-shim: this host can't run agents unless a test says it can (runs::TEST_CAN_RUN).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/** A project, and a task in review with a worktree that has a commit of its own on a branch off master. */
function setup(s: AppState): [Project, Task, string] {
  const p = db.insert_profile(s.db(), "p", [], null);
  const np = { id: "pr", profile_id: p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: "master", use_worktrees: true };
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

test("a_graph_needs_one_trigger_real_ports_and_no_loops", () => {
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
  bad({ nodes: [], edges: [] }, "exactly one trigger");
  bad({ nodes: [{ id: "a", kind: "trigger", on: "status" }], edges: [] }, "needs the column");
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
  bad(into_trigger, "into the trigger");
  const looped = {
    nodes: [
      { id: "a", kind: "trigger", on: "manual" },
      { id: "b", kind: "set_status", status: "todo" },
      { id: "c", kind: "set_status", status: "backlog" },
    ],
    edges: [
      { from: "a", port: "out", to: "b" },
      { from: "b", port: "out", to: "c" },
      { from: "c", port: "out", to: "b" },
    ],
  };
  bad(looped, "loop through b");
  const manual = { id: "a", kind: "trigger", on: "manual" };
  bad({ nodes: [manual, { id: "b", kind: "set_status", status: "done" }], edges: [] }, "needs a column");
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
  const out = prompt.render("{{task.key}} {{ task.title }} on {{branch}} at {{commit}}: {{review.text}}\n{{issues}} {{nope}} {{unclosed", task, "X-1", "W", run);
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

test("a_set_status_step_doesnt_start_its_own_workflow_again", async () => {
  const s = testing.state();
  const [project, task] = setup(s);
  db.update_task(s.db(), task.id, [["status", "todo"]]);
  // It moves the task into the column that triggers it: once, not over and over.
  const w = make(s, project, {
    nodes: [
      { id: "t", kind: "trigger", on: "status", status: "in_review" },
      { id: "m", kind: "set_status", status: "in_review" },
    ],
    edges: [{ from: "t", port: "out", to: "m" }],
  });
  const run = (await start(s, w.id, task.id, true))!;
  assert.equal(run.state, "done");
  await sleep(200);
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?1", w.id), 1);
});

// ---------- HA-189's own ----------

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
