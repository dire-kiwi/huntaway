// Port of server/src/integrations/workflows/engine.rs (HA-173's branch, ported by HA-189).
// Running a workflow on a task: starting a run from its trigger, following the graph from node to node, and the agent
// steps' threads (their verdicts, their ends, and stopping them).
//
// Rust held `UPDATING` (a mutex) while changing a run, so a step that ends can't save over a run that's being stopped;
// here those sections are synchronous (no await inside them), which keeps them whole on Node's one thread.
import * as db from "../../db.ts";
import type { Conn, Task } from "../../db.ts";
import * as api from "../../api.ts";
import * as runner from "../../agent/runner.ts";
import type { Outcome } from "../../agent/runner.ts";
import * as runs from "../../agent/runs.ts";
import * as context from "../../agent/context.ts";
import * as prompts from "../../agent/prompts.ts";
import * as worktree from "../../git/worktree.ts";
import { ApiError } from "../../http.ts";
import * as review from "../../review.ts";
import { AsyncMutex, type Shared } from "../../state.ts";
import { background, err_str, new_id, now } from "../../util.ts";
import {
  get,
  get_run,
  graph_node,
  insert_run,
  latest_run,
  list,
  node_entry,
  run_node,
  Run_from_row,
  running,
  save_run,
  settled,
  trigger_status,
  WORKFLOW,
  type Node,
  type NodeRun,
  type Run,
  type Check,
} from "../workflows.ts";
import * as prompt from "./prompt.ts";
import type { Work } from "./prompt.ts";
import * as history from "../../threads/history.ts";

/** Held while starting a run, so two can't start for one workflow on one task at once (made on first use: see PORTING.md). */
let STARTING: AsyncMutex | null = null;

/** (task, workflow) pairs whose move step is moving the task, so the move doesn't start the same workflow again. */
const MOVING: Array<[string, string]> = [];

/** An error's message, as Rust's `e.1` of an ApiError (and `{e:#}` of anything else). */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : err_str(e));

/** Whether `thread` is a workflow's agent thread. */
export function is_workflow(thread: Task): boolean {
  return thread.kind === "review" && thread.task_type === WORKFLOW;
}

/** The task's workflow runs changed: the board reads them again. */
export function runs_changed(s: Shared, task_id: string): void {
  s.emit({ type: "workflow_runs_changed", task_id });
}

function task_key(c: Conn, t: Task): string {
  const p = t.project_id ? db.get_project(c, t.project_id) : null;
  return `${p?.key ?? "T"}-${t.number}`;
}

/** The task entered the column it's in: start the project's workflows that trigger on that, in the background. */
export function on_status(s: Shared, task: Task): void {
  if (task.kind !== "task" || !task.project_id) return;
  const moving = MOVING.filter(([t]) => t === task.id).map(([, w]) => w);
  let due;
  try {
    due = list(s.db(), task.project_id).filter((w) => w.enabled && trigger_status(w.graph) === task.status && !moving.includes(w.id));
  } catch (e) {
    console.error(`reading workflows for task ${task.id}: ${err_str(e)}`);
    return;
  }
  for (const w of due) {
    background(
      "starting a workflow",
      start(s, w.id, task.id, false).catch((e) => s.add_event(task.id, "warn", `Couldn't run the workflow "${w.name}"`, msg(e))),
    );
  }
}

function skip(manual: boolean, why: string): null {
  if (manual) throw ApiError.conflict(`Can't run the workflow: ${why}`);
  return null;
}

async function rev_parse(dir: string, rev: string): Promise<string | null> {
  try {
    const o = await worktree.git(dir, ["rev-parse", "--verify", rev]);
    const out = o.stdout.trim();
    return o.ok && out ? out : null;
  } catch {
    return null;
  }
}

/**
 * Run workflow `workflow_id` on task `task_id`. `manual` (the user, or an agent, asked for it) runs it whether or not
 * it's on or its trigger matches, with fresh rounds, and says why when it can't. Returns the run, or null when there
 * was nothing to do.
 */
export async function start(s: Shared, workflow_id: string, task_id: string, manual: boolean): Promise<Run | null> {
  const release = await (STARTING ??= new AsyncMutex()).lock();
  try {
    return await start_locked(s, workflow_id, task_id, manual);
  } finally {
    release();
  }
}

async function start_locked(s: Shared, workflow_id: string, task_id: string, manual: boolean): Promise<Run | null> {
  const w = get(s.db(), workflow_id);
  if (!w) throw ApiError.not_found("workflow");
  const task = db.get_task(s.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  if (task.kind !== "task" || task.project_id !== w.project_id) throw ApiError.bad("a workflow runs only on its own project's tasks");
  const project = db.get_project(s.db(), w.project_id);
  if (!project) throw ApiError.not_found("project");
  if (project.archived_at) return skip(manual, "the project is archived");
  if (!manual && (!w.enabled || trigger_status(w.graph) !== task.status)) return null;
  // Read before the check that it isn't running, so a run that starts in between counts as later (see below).
  const task_run = db.latest_run(s.db(), task.id, null);
  if (s.is_running(task.id)) return skip(manual, "the task's agent is still working");
  const previous = latest_run(s.db(), w.id, task.id);
  if (previous?.state === "running") return skip(manual, "it's already running on this task");
  const head = task.worktree_path && task.worktree_state === "ready" ? await rev_parse(task.worktree_path, "HEAD") : null;
  const at = now();
  const nodes: Record<string, NodeRun> = {};
  for (const n of w.graph.nodes) {
    nodes[n.id] = n.kind === "trigger" ? { state: "done", port: "out", started_at: at, finished_at: at } : { state: "pending" };
  }
  const run: Run = {
    id: new_id(),
    workflow_id: w.id,
    task_id: task.id,
    source: manual ? "manual" : "status",
    state: "running",
    head,
    task_run,
    graph: w.graph,
    nodes,
    rounds: manual ? {} : (previous?.rounds ?? {}),
    detail: null,
    created_at: at,
    updated_at: at,
    finished_at: null,
  };
  // The agent may have started again while git was read: `supersede` found no run to stop then.
  if (db.later_run(s.db(), task.id, task_run ?? "") || s.is_running(task.id)) return skip(manual, "the task's agent is working again");
  insert_run(s.db(), run);
  s.add_event(task.id, "info", `Running the workflow "${w.name}"`);
  runs_changed(s, task.id);
  await advance(s, run.id);
  return get_run(s.db(), run.id);
}

/**
 * Marks the nodes whose inputs have all settled as running (to run now) or skipped, until none are left to decide.
 * Returns those to run.
 */
export function plan(run: Run): string[] {
  const at = now();
  for (;;) {
    const ready: string[] = [];
    let changed = false;
    for (const n of run.graph.nodes) {
      if (run_node(run, n.id).state !== "pending") continue;
      const incoming = run.graph.edges.filter((e) => e.to === n.id);
      if (!incoming.every((e) => settled(run_node(run, e.from)))) continue;
      const taken = incoming.filter((e) => {
        const from = run_node(run, e.from);
        return from.state !== "skipped" && from.port === e.port;
      }).length;
      const go = taken > 0 && ((n.join ?? "any") === "any" || taken === incoming.length);
      const r = node_entry(run, n.id);
      if (go) {
        r.state = "running";
        r.started_at = at;
        ready.push(n.id);
      } else {
        r.state = "skipped";
      }
      changed = true;
    }
    if (ready.length || !changed) return ready;
  }
}

/** Ends the run once no node is left to run: its sends that weren't reached give their rounds back. */
function settle(run: Run): boolean {
  if (run.state !== "running" || run.graph.nodes.some((n) => !settled(run_node(run, n.id)))) return false;
  for (const n of run.graph.nodes) {
    if (n.kind === "send_to_task" && run_node(run, n.id).state === "skipped") delete run.rounds[n.id];
  }
  run.state = "done";
  run.finished_at = now();
  run.updated_at = now();
  return true;
}

/** What a node did. */
export interface Done {
  state: string;
  port: string | null;
  text: string | null;
}

const Done_port = (port: string): Done => ({ state: "done", port, text: null });
const Done_failed = (why: string): Done => ({ state: "failed", port: "failed", text: why });

/** Records what node `id` did, if the run is still going and the node still running. Returns the run as saved. */
function record(s: Shared, run_id: string, id: string, done: Done): Run | null {
  let run: Run | null;
  try {
    run = get_run(s.db(), run_id);
  } catch {
    return null;
  }
  if (!run || run.state !== "running" || run_node(run, id).state !== "running") return null;
  const r = node_entry(run, id);
  // A node that has no such port (a condition can't fail) only ends.
  r.state = done.state;
  if (done.port != null) r.port = done.port;
  else delete r.port;
  if (done.text != null) r.text = done.text;
  r.finished_at = now();
  run.updated_at = now();
  save(s, run);
  return run;
}

function save(s: Shared, run: Run): void {
  try {
    save_run(s.db(), run);
  } catch (e) {
    console.error(`saving workflow run ${run.id}: ${err_str(e)}`);
  }
  runs_changed(s, run.task_id);
}

/** Runs what's ready to run, until the run waits only on its agents or has ended. */
export async function advance(s: Shared, run_id: string): Promise<void> {
  for (;;) {
    let run: Run | null;
    try {
      run = get_run(s.db(), run_id);
    } catch {
      return;
    }
    if (!run || run.state !== "running") return;
    const ready = plan(run);
    const ended = settle(run);
    save(s, run);
    if (ended) {
      ended_run(s, run);
      return;
    }
    if (!ready.length) return;
    for (const id of ready) {
      const node = graph_node(run.graph, id);
      if (!node) continue;
      let done: Done | null;
      switch (node.kind) {
        case "trigger":
          done = Done_port("out");
          break;
        case "condition":
          try {
            done = Done_port((await condition(s, run, node.check, node.value ?? null)) ? "yes" : "no");
          } catch (e) {
            done = { state: "failed", port: null, text: typeof e === "string" ? e : err_str(e) };
          }
          break;
        case "agent":
          try {
            await start_agent(s, run, node);
            done = null;
          } catch (e) {
            done = Done_failed(typeof e === "string" ? e : msg(e));
          }
          break;
        case "send_to_task":
          done = send(s, run, node, node.message, node.max_rounds);
          break;
        case "set_status":
          done = await move_task(s, run, node.status);
          break;
      }
      if (done) record(s, run_id, id, done);
    }
  }
}

/** The run has ended: say how on the task. */
function ended_run(s: Shared, run: Run): void {
  let name = "";
  try {
    name = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const failed = run.graph.nodes.filter((n) => run_node(run, n.id).state === "failed").map((n) => `${node_name(n)}: ${run_node(run, n.id).text ?? ""}`);
  if (!failed.length) s.add_event(run.task_id, "info", `The workflow "${name}" finished`);
  else s.add_event(run.task_id, "warn", `The workflow "${name}" finished with steps that failed`, failed.join("\n"));
}

/** How a node reads in events: an agent step's name, or its kind. */
export function node_name(n: Node): string {
  switch (n.kind) {
    case "agent":
      return n.name;
    case "trigger":
      return "Trigger";
    case "condition":
      return "Condition";
    case "send_to_task":
      return "Send to the task's agent";
    case "set_status":
      return "Move the task";
  }
}

/** The run's last finished run of the same workflow on the same task, before it. */
function last_done(c: Conn, run: Run): Run | null {
  const r = db.one(
    c,
    "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 AND state='done' ORDER BY rowid DESC LIMIT 1",
    run.workflow_id,
    run.task_id,
    run.id,
  );
  return r ? Run_from_row(r) : null;
}

/** A check on the task. Throws a string saying why it couldn't be made. */
async function condition(s: Shared, run: Run, check: Check, value: string | null): Promise<boolean> {
  let task: Task | null;
  try {
    task = db.get_task(s.db(), run.task_id);
  } catch (e) {
    throw err_str(e);
  }
  if (!task) throw "the task is gone";
  switch (check) {
    case "has_pr":
      return !!task.pr_url?.trim();
    case "task_type":
      return (task.task_type ?? "code") === (value ?? "code");
    case "label":
      return value != null && task.labels.includes(value);
    case "has_commits":
      return !(await elsewhere(s, task))[1];
    case "changed": {
      // A run by hand is asked for whatever changed.
      if (run.source === "manual") return true;
      // Since the latest of its runs on the task that finished.
      let last: Run | null;
      try {
        last = last_done(s.db(), run);
      } catch (e) {
        throw err_str(e);
      }
      return last == null || last.head !== run.head || last.task_run !== run.task_run;
    }
  }
}

/**
 * Where the task's work is (its worktree, branch, base and whether it starts later than its base), and whether its
 * branch has no commits of its own. Throws a string saying why it can't tell.
 */
async function elsewhere(s: Shared, task: Task): Promise<[Work, boolean]> {
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  if (!project) throw "the task has no project";
  const dir = task.worktree_state === "ready" ? task.worktree_path : null;
  if (!dir || !task.branch) throw "the task has no worktree";
  const head = await rev_parse(dir, "HEAD");
  if (!head) throw "couldn't read the worktree's HEAD commit";
  const [base, own_start] = await worktree.work_scope(s, dir, task, project);
  let elsewhere = false;
  if (base != null) {
    let merge_base: string | null = null;
    try {
      const o = await worktree.git(dir, ["merge-base", base, "HEAD"]);
      if (o.ok) merge_base = o.stdout.trim();
    } catch {}
    elsewhere = merge_base === head;
  }
  const work: Work = {
    key: task_key(s.db(), task),
    branch: task.branch,
    base,
    commit: head.slice(0, 10),
    elsewhere,
    own_start,
    last_message: null,
  };
  return [work, elsewhere];
}

/** The thread an agent step works in: the one it had in an earlier run on the task, while its agent is the same. */
function thread_for(s: Shared, run: Run, node_id: string, config: string | null, model: string | null, effort: string | null): Task | null {
  const c = s.db();
  const earlier = db
    .all(c, "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 ORDER BY rowid DESC LIMIT 20", run.workflow_id, run.task_id, run.id)
    .map(Run_from_row);
  for (const r of earlier) {
    const id = r.nodes[node_id]?.thread_id;
    if (!id) continue;
    const t = db.get_task(c, id);
    if (t && is_workflow(t) && t.parent_id === run.task_id) {
      if ((t.claude_config_id ?? null) === config && (t.model ?? null) === model && (t.effort ?? null) === effort) return t;
    }
    return null;
  }
  return null;
}

/** Starts an agent step's thread on its prompt. It ends in `finished`. Throws a string saying why it couldn't start. */
async function start_agent(s: Shared, run: Run, node: Node): Promise<void> {
  if (node.kind !== "agent") return;
  const { name, prompt: instructions, output } = node;
  const claude_config_id = node.claude_config_id ?? null;
  const model = node.model ?? null;
  const effort = node.effort ?? null;
  const skills = node.skills ?? [];
  if (!runs.can_run_agents(s)) throw "this host can't run agents";
  const task = db.get_task(s.db(), run.task_id);
  if (!task) throw "the task is gone";
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  if (!project) throw "the task has no project";
  let workflow = "";
  try {
    workflow = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const [work, is_elsewhere] = await elsewhere(s, task);
  if (is_elsewhere) work.last_message = history.last_assistant_text(s.db(), task.id);
  const task_config = db.task_claude_config(s.db(), task);
  // A step whose config was deleted works with the task's.
  const config = claude_config_id != null ? (db.get_claude_config(s.db(), claude_config_id) ?? task_config) : task_config;
  const config_id = config?.id ?? null;
  const label = review.label(config, model, effort);
  const codex = config != null && db.is_codex(config);
  // What the steps before it in the run said.
  const earlier: Array<[string, string]> = [];
  for (const n of run.graph.nodes) {
    if (n.kind !== "agent") continue;
    const r = run.nodes[n.id];
    if (r?.state === "done" && r.text != null) earlier.push([n.name, r.text]);
  }
  const replies = output === "verdict" ? history.user_replies(s.db(), task.id, review.REPLIES) : null;
  const existing = thread_for(s, run, node.id, config_id, model, effort);
  // Issues it found last time, if the agent was sent them since.
  let recheck: string[] = [];
  if (output === "verdict" && Object.keys(run.rounds).length) {
    const last = last_done(s.db(), run);
    const n = last?.nodes[node.id];
    if (n?.port === "issues") recheck = n.issues ?? [];
  }
  const rendered = prompt.render(instructions, task, work.key, workflow, run);
  const asked = rendered.trim() ? rendered : output === "verdict" ? prompts.review(project) : `Read the work, and report on it as "${name}".`;
  const text = prompt.agent(task, work, workflow, name, asked, output, skills, codex, earlier, replies, recheck);
  const title = `${name} (${workflow}) of ${work.key}`;
  let thread: Task;
  if (existing) {
    if (existing.title !== title) s.update_task(existing.id, [["title", title]]);
    thread = existing;
  } else {
    const t = db.insert_task(s.db(), {
      profile_id: task.profile_id,
      project_id: project.id,
      kind: "review",
      title,
      description: "",
      status: "todo",
      use_worktree: false,
      model,
      effort,
      claude_config_id: config_id,
    });
    const u = s.update_task(t.id, [
      ["parent_id", task.id],
      ["task_type", WORKFLOW],
    ]);
    if (!u) throw "the thread is gone";
    thread = u;
  }
  if (s.is_running(thread.id)) throw `its thread's agent (${label}) is busy`;
  const after_run = db.latest_run(s.db(), thread.id, null) ?? "";
  db.set_thread_skills(s.db(), thread.id, skills);
  // A fresh conversation each run; the thread keeps every one's messages.
  s.update_task(thread.id, [["session_id", null]]);
  context.clear(s, thread.id);
  // From here on there's no await, as Rust held `UPDATING` (which `supersede` stops runs under): a step of a run it
  // has stopped doesn't start, and one that starts first is stopped with it.
  const current = get_run(s.db(), run.id);
  if (!current) throw "the run is gone";
  if (current.state !== "running" || run_node(current, node.id).state !== "running") return;
  const r = node_entry(current, node.id);
  r.thread_id = thread.id;
  r.label = label;
  r.after_run = after_run;
  current.updated_at = now();
  save(s, current);
  s.add_event(thread.id, "info", `Running "${name}" on commit ${work.commit}`);
  try {
    runner.send_review(s, thread.id, text);
  } catch (e) {
    throw msg(e);
  }
}

/**
 * A send step: the message to the task's agent, if it has rounds left. Ends the run once it's sent (null), as the
 * agent's work changes under it.
 */
function send(s: Shared, run: Run, node: Node, message: string, max_rounds: number): Done | null {
  let task: Task | null = null;
  try {
    task = db.get_task(s.db(), run.task_id);
  } catch {}
  if (!task) return Done_failed("the task is gone");
  let workflow = "";
  try {
    workflow = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const key = task_key(s.db(), task);
  const issues = prompt.issues(run);
  let text: string;
  if (!message.trim()) {
    if (!issues.length) return Done_failed("there are no issues to send (and the step has no message of its own)");
    text = prompt.fixes(workflow, issues);
  } else {
    text = prompt.render(message, task, key, workflow, run);
  }
  const used = run.rounds[node.id] ?? 0;
  if (used >= max_rounds) {
    const has_next = run.graph.edges.some((e) => e.from === node.id && e.port === "exhausted");
    const n = issues.length;
    const sn = n === 1 ? "" : "s";
    const reason =
      n === 0
        ? `The workflow "${workflow}" is out of rounds`
        : used === 0
          ? `The workflow "${workflow}" found ${n} serious issue${sn}`
          : used === 1
            ? `The workflow "${workflow}" found ${n} serious issue${sn} after a round of fixes`
            : `The workflow "${workflow}" found ${n} serious issue${sn} after ${used} rounds of fixes`;
    s.add_event(task.id, "warn", reason, issues.length ? issues.join("\n\n") : null);
    if (!has_next && !s.is_running(task.id) && task.status !== "done" && !task.merging) {
      try {
        s.update_task(task.id, [
          ["status", "needs_attention"],
          ["attention_reason", reason],
        ]);
      } catch (e) {
        console.error(`flagging a task: ${err_str(e)}`);
      }
    }
    return Done_port("exhausted");
  }
  if (s.is_running(task.id) || task.status === "done" || task.merging) {
    // The user (or the agent) has moved on: the findings are left for them.
    s.add_event(task.id, "warn", `The workflow "${workflow}" didn't send its message: the task has moved on`, text);
    return Done_failed("the task has moved on (its agent is working, or it's done or merging)");
  }
  // Ends the run, and stops its other steps: the agent's work is about to change.
  const round = used + 1;
  let current: Run | null = null;
  try {
    current = get_run(s.db(), run.id);
  } catch {}
  if (!current || current.state !== "running") return null;
  const at = now();
  current.rounds[node.id] = round;
  const r = node_entry(current, node.id);
  r.state = "done";
  r.port = "sent";
  r.text = text;
  r.finished_at = at;
  const threads = end_nodes(current, "Stopped because the task's agent was sent a message.");
  current.state = "done";
  current.finished_at = at;
  current.updated_at = at;
  save(s, current);
  for (const t of threads) runner.stop(s, t);
  try {
    runner.send_fixes(s, task.id, text, round);
  } catch (e) {
    s.add_event(task.id, "error", `The workflow "${workflow}" couldn't send its message to the agent`, msg(e));
  }
  return null;
}

/** Marks a run's nodes still to run as skipped and those running as stopped, saying `why`. Returns the threads to stop. */
function end_nodes(run: Run, why: string): string[] {
  const threads: string[] = [];
  const at = now();
  for (const n of run.graph.nodes) {
    const r = node_entry(run, n.id);
    if (r.state === "pending") r.state = "skipped";
    else if (r.state === "running") {
      r.state = "stopped";
      delete r.port;
      r.text = why;
      r.finished_at = at;
      if (r.thread_id) threads.push(r.thread_id);
    }
  }
  return threads;
}

async function move_task(s: Shared, run: Run, status: string): Promise<Done> {
  const key: [string, string] = [run.task_id, run.workflow_id];
  MOVING.push(key);
  try {
    await api.update_task_inner(s, run.task_id, { status });
    return Done_port("out");
  } catch (e) {
    return Done_failed(msg(e));
  } finally {
    MOVING.splice(MOVING.indexOf(key), 1);
  }
}

/** The running run and node agent thread `thread` works for, if any. */
function step_of(s: Shared, thread: Task): [Run, string] | null {
  if (!thread.parent_id) return null;
  let rs: Run[];
  try {
    rs = running(s.db(), thread.parent_id);
  } catch {
    return null;
  }
  for (const r of rs) {
    const id = Object.keys(r.nodes).sort().find((k) => r.nodes[k].state === "running" && r.nodes[k].thread_id === thread.id);
    if (id !== undefined) return [r, id];
  }
  return null;
}

/** Whether run `run_id` of the thread is the one its step asked for (not an earlier one ending late). */
function asked(s: Shared, thread: Task, r: NodeRun, run_id: string): boolean {
  if (r.after_run == null) return false;
  try {
    return db.run_after(s.db(), thread.id, run_id, r.after_run);
  } catch {
    return false;
  }
}

/** `submit_review` from a workflow's verdict step: its verdict, acted on when its run ends. */
export function submit(s: Shared, thread: Task, run_id: string, args: any): any {
  const step = step_of(s, thread);
  if (!step) throw ApiError.conflict("no workflow step is running in this thread, so there's nothing to submit");
  const [run, id] = step;
  const n = graph_node(run.graph, id);
  if (!(n?.kind === "agent" && n.output === "verdict")) {
    throw ApiError.conflict("this step reports with its last message, not submit_review: end your turn with its output");
  }
  if (!asked(s, thread, run_node(run, id), run_id)) throw ApiError.conflict("the step this run was asked for has ended, so there's nothing to submit");
  const si = args?.serious_issues;
  const issues: string[] = Array.isArray(si)
    ? si.filter((i: any) => typeof i === "string").map((i: string) => i.trim()).filter((i: string) => i)
    : typeof si === "string" && si.trim()
      ? [si.trim()]
      : [];
  const summary = typeof args?.summary === "string" && args.summary.trim() ? args.summary.trim() : null;
  if (args?.verdict === "needs_fixes" && !issues.length) {
    issues.push(summary ?? "The step asked for fixes without saying what they are; see its thread.");
  }
  const r = node_entry(run, id);
  r.verdict = issues.length ? "issues" : "pass";
  if (issues.length) r.issues = issues;
  else delete r.issues;
  if (summary != null) r.text = summary;
  else delete r.text;
  run.updated_at = now();
  save(s, run);
  return { ok: true, note: "Recorded. End your turn now with a short summary." };
}

/** Agent thread `thread`'s run `run_id` ended: its step's output, and on from there. */
export function finished(s: Shared, thread: Task, run_id: string, outcome: Outcome, attention: string | null): void {
  const id = step_ended(s, thread, run_id, outcome, attention);
  if (id != null) background("advancing a workflow run", advance(s, id));
}

/** Records how the step thread `thread` worked for ended, if its run `run_id` was the step's. Returns the workflow run's id. */
export function step_ended(s: Shared, thread: Task, run_id: string, outcome: Outcome, attention: string | null): string | null {
  const step = step_of(s, thread);
  if (!step) return null;
  const [run, id] = step;
  const r = run_node(run, id);
  if (!asked(s, thread, r, run_id)) return null;
  const n = graph_node(run.graph, id);
  const verdict = n?.kind === "agent" && n.output === "verdict";
  const written = (): string | null => {
    try {
      return history.said_since_asked(s.db(), thread.id)?.trim() || null;
    } catch {
      return null;
    }
  };
  let state: string;
  let port: string | null;
  let text: string | null;
  if (outcome === "Cancelled") [state, port, text] = ["stopped", null, "The step was stopped."];
  else if (typeof outcome === "object") [state, port, text] = ["failed", "failed", `The step failed: ${outcome.Failed.split("\n")[0]}`];
  else if (attention != null) [state, port, text] = ["failed", "failed", `The step's agent asked: ${attention}`];
  else if (verdict && r.verdict == null) [state, port, text] = ["failed", "failed", "The step finished without submitting a verdict."];
  else if (verdict) [state, port, text] = ["done", r.verdict === "pass" ? "pass" : "issues", r.text ?? written()];
  else {
    const t = written();
    [state, port, text] = t != null ? ["done", "done", t] : ["failed", "failed", "The step finished without writing its output."];
  }
  const e = node_entry(run, id);
  e.state = state;
  if (port != null) e.port = port;
  else delete e.port;
  if (text != null) e.text = text;
  else delete e.text;
  e.finished_at = now();
  run.updated_at = now();
  save(s, run);
  return run.id;
}

/** Stops a run in progress, saying `why`. Returns whether it was in progress. */
export function stop_run(s: Shared, run_id: string, why: string): boolean {
  let run: Run | null = null;
  try {
    run = get_run(s.db(), run_id);
  } catch {}
  if (!run || run.state !== "running") return false;
  const threads = end_nodes(run, why);
  run.state = "stopped";
  run.detail = why;
  run.finished_at = now();
  run.updated_at = now();
  save(s, run);
  for (const t of threads) runner.stop(s, t);
  return true;
}

function stop_all(s: Shared, task_id: string, why: string): boolean {
  let rs: Run[] = [];
  try {
    rs = running(s.db(), task_id);
  } catch {}
  let any = false;
  for (const r of rs) any = stop_run(s, r.id, why) || any;
  return any;
}

/** The task's agent started working again: its workflows' runs in progress are out of date. */
export function supersede(s: Shared, task: Task): void {
  stop_all(s, task.id, "Stopped because the agent started working on the task again.");
}

/** The user stopped the task: stop its workflows' runs too. Returns whether any was running. */
export function stop(s: Shared, task_id: string): boolean {
  const stopped = stop_all(s, task_id, "Stopped by the user.");
  if (stopped) s.add_event(task_id, "warn", "Workflow stopped");
  return stopped;
}

/**
 * On start: steps that were running on the board itself when the server stopped (not agents, which carry on) failed,
 * and the runs go on from there.
 */
export function resume(s: Shared): void {
  let rs: Run[] = [];
  try {
    rs = running(s.db(), null);
  } catch {}
  for (const run of rs) {
    let changed = false;
    for (const n of run.graph.nodes) {
      if (n.kind === "agent") continue;
      const r = node_entry(run, n.id);
      if (r.state === "running") {
        r.state = "failed";
        r.port = "failed";
        r.text = "Interrupted: the server stopped while this ran.";
        changed = true;
      }
    }
    if (changed) save(s, run);
  }
  for (const run of rs) background("resuming a workflow run", advance(s, run.id));
}
