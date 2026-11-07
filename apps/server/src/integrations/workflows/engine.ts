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
  trigger,
  column_node,
  COLUMN_ROUNDS,
  agent_works,
  after_done,
  data_inputs,
  flow_edges,
  is_data,
  template_inputs,
  wire,
  opens_pr,
  status_label,
  upstream,
  WORKFLOW,
  type ColumnNode,
  type Graph,
  type TriggerOn,
  type Workflow,
  type Node,
  type NodeRun,
  type Run,
  type Check,
} from "../workflows.ts";
import * as prompt from "./prompt.ts";
import type { Work } from "./prompt.ts";
import * as history from "../../threads/history.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import * as documents from "../../agent/documents.ts";
import type { Project } from "../../db.ts";

/** Held while starting a run, so two can't start for one workflow on one task at once (made on first use: see PORTING.md). */
let STARTING: AsyncMutex | null = null;

/**
 * The tasks workflows' move steps are moving, each with the workflow (so the move doesn't start the same workflow again)
 * and how many runs in a row the move continues (see CHAIN).
 */
const MOVING: Array<{ task: string; workflow: string; chain: number }> = [];

/**
 * Runs that another workflow's move started, by id: how many runs in a row (each started by the one before's move)
 * led to them. Two workflows whose steps move the task into each other's trigger columns would go on forever.
 */
const CHAIN = new Map<string, number>();

/** How many runs in a row moves may start on a task (counting the first), before the next isn't started. */
export const MAX_CHAIN = 10;

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

/**
 * Column nodes a run's end just moved the task back into (see `release`), by `task|workflow|node`: the column's work is
 * what ended, so entering it again doesn't start it again.
 */
const QUIET = new Set<string>();

/** The project's workflows that are on, with their nodes for column `status`. */
function columns(c: Conn, project_id: string, status: string): Array<[Workflow, ColumnNode]> {
  return list(c, project_id).flatMap((w): Array<[Workflow, ColumnNode]> => {
    const n = w.enabled ? column_node(w.graph, status) : undefined;
    return n ? [[w, n]] : [];
  });
}

/** The column node a run waits at for the task's agent's work there, which it was sent the prompt of. */
export function waiting_column(run: Run): ColumnNode | null {
  for (const n of run.graph.nodes) {
    const r = run.nodes[n.id];
    if (n.kind === "column" && r?.start && r.state === "running") return n;
  }
  return null;
}

/**
 * The task entered the column it's in: start the project's workflows at their nodes for that column, in the
 * background. In In progress and Ready for merge they start when the agent's work there is done (see `on_finish_due`
 * and `on_merged`, which a task done as merged starts), not now. A run waiting for the work of a column the task has
 * left is over.
 */
export function on_status(s: Shared, task: Task): void {
  if (task.kind !== "task" || !task.project_id) return;
  const movers = MOVING.filter((m) => m.task === task.id);
  // Moved by a workflow's step: the runs it starts continue that one's chain.
  const chain = movers.length ? Math.max(...movers.map((m) => m.chain)) + 1 : 0;
  let due: Array<[Workflow, ColumnNode]>;
  try {
    left_columns(s, task);
    if (task.status === "in_progress" || task.status === "ready_for_merge") return;
    if (db.is_merged(task)) on_merged(s, task);
    due = columns(s.db(), task.project_id, task.status).filter(([w, n]) => !QUIET.delete(`${task.id}|${w.id}|${n.id}`));
  } catch (e) {
    console.error(`reading workflows for task ${task.id}: ${err_str(e)}`);
    return;
  }
  if (due.length && chain >= MAX_CHAIN) {
    const names = due.map(([w]) => `"${w.name}"`).join(", ");
    s.add_event(
      task.id,
      "warn",
      `Didn't run ${due.length === 1 ? "the workflow" : "the workflows"} ${names}: workflows have moved the task ${chain} times in a row`,
      "Their steps may be moving the task from column to column and back. Moving the task yourself (or running a workflow by hand) starts again.",
    );
    return;
  }
  for (const [w, n] of due) {
    background(
      "starting a workflow",
      start(s, w.id, task.id, false, chain, "status", n.id).catch((e) => s.add_event(task.id, "warn", `Couldn't run the workflow "${w.name}"`, msg(e))),
    );
  }
}

/**
 * Stops the runs waiting for the work of a column the task has left. Its agent's work moves it to In progress, and a
 * question it asks to Needs attention, without leaving the column it works for.
 */
function left_columns(s: Shared, task: Task) {
  if (task.status === "in_progress" || task.status === "needs_attention") return;
  for (const r of running(s.db(), task.id)) {
    const n = waiting_column(r);
    if (n && n.status !== task.status) stop_run(s, r.id, `Stopped because the task left ${status_label(n.status)}.`);
  }
}

/** The column node whose work the task's agent's run did, which its end is the end of (see `on_finish_due`). */
export interface Due {
  workflow_id: string;
  node: ColumnNode;
  /** The run waiting at the node, which the agent was sent its prompt by; none for In progress. */
  run_id: string | null;
}

/**
 * The column node that takes the task on once its agent's run ends with its work done (HA-276): the column whose
 * prompt it was sent, or else In progress's. The task stays in its column for it, rather than going to "In review".
 */
export function on_finish_due(s: Shared, task: Task): Due | null {
  if (task.kind !== "task" || !task.project_id || task.subproject) return null;
  try {
    const c = s.db();
    const p = db.get_project(c, task.project_id);
    if (!p || p.archived_at) return null;
    for (const r of running(c, task.id)) {
      const n = waiting_column(r);
      if (n && db.later_run(c, task.id, r.task_run ?? "")) return { workflow_id: r.workflow_id, node: n, run_id: r.id };
    }
    // With nothing after it (and not waiting for finish_work), there's nothing to hold the task for.
    const [found] = columns(c, task.project_id, "in_progress").filter(([w, n]) => n.done_when === "finish" || flow_edges(w.graph).some((e) => e.from === n.id));
    return found ? { workflow_id: found[0].id, node: found[1], run_id: null } : null;
  } catch (e) {
    console.error(`reading workflows for task ${task.id}: ${err_str(e)}`);
    return null;
  }
}

/** Why a task whose agent ended its run without saying its work was done (`done_when: finish`) needs attention. */
export function unfinished(due: Due): string {
  return `The agent ended its turn without saying its work in ${status_label(due.node.status)} is done (with finish_work)`;
}

/**
 * Whether a task gets In progress's prompt, with what to do when it's done: as the project's start prompt, only its code
 * tasks do (not a scratch task, nor one that makes only documents).
 */
function takes_start_prompt(task: Task): boolean {
  return task.task_type == null && !documents.documents_only(task);
}

/**
 * Whether the task's agent was asked to say its work for `due` is done with `finish_work`, so a run that ends without
 * it needs attention: a column waiting for it whose prompt (with that note) the agent gets.
 */
export function asks_finish(task: Task, due: Due): boolean {
  return due.node.done_when === "finish" && (due.node.status !== "in_progress" || takes_start_prompt(task));
}

/** The task's agent's run ended without the `finish_work` its column `due` waits for: it needs attention, saying so. */
export function flag_unfinished(s: Shared, task: Task, due: Due): void {
  background(
    "flagging a task",
    (async () => {
      const t = db.get_task(s.db(), task.id);
      if (!t || t.status !== "in_progress" || t.running || s.is_running(task.id)) return;
      await api.update_task_inner(s, task.id, { status: "needs_attention" });
      attention(s, task.id, unfinished(due));
    })().catch((e) => s.add_event(task.id, "warn", "Couldn't move the task on", msg(e))),
  );
}

/**
 * What a message the workflow sends the task's agent to work again (fixes, say) ends with, when the project's In
 * progress node waits for `finish_work`: how to say it's done, and what the board does then, as its start prompt said.
 */
function finish_note(s: Shared, task: Task): string {
  const found = work_column(s, task, "in_progress");
  if (!found || found[1].done_when !== "finish" || !takes_start_prompt(task)) return "";
  return done_note(found[0].graph, found[1]);
}

/** `text`, with `finish_note` after it unless it says so already. */
function with_finish(s: Shared, task: Task, text: string): string {
  const note = finish_note(s, task);
  return note && !text.includes(note) ? `${text}\n\n${note}` : text;
}

/** The task's agent's work for `due` is done (and the task was left in its column for it): its run goes on from there. */
export function on_finished(s: Shared, task: Task, due: Due): void {
  const failed = (e: unknown) => {
    let name = due.workflow_id;
    try {
      name = get(s.db(), due.workflow_id)?.name ?? name;
    } catch {}
    s.add_event(task.id, "warn", `Couldn't run the workflow "${name}"`, msg(e));
  };
  if (due.run_id == null) {
    background(
      "starting a workflow",
      start(s, due.workflow_id, task.id, false, 0, "finished", due.node.id)
        .then((run) => {
          if (!run) unheld(s, task.id);
        })
        .catch((e) => {
          failed(e);
          unheld(s, task.id);
        }),
    );
    return;
  }
  const run = get_run(s.db(), due.run_id);
  if (!run || run.state !== "running" || run_node(run, due.node.id).state !== "running") return unheld(s, task.id);
  const r = node_entry(run, due.node.id);
  r.state = "done";
  r.port = "done";
  r.finished_at = now();
  // It holds the task now, as a run that its agent finishing started does (see `release`), from the run that ended.
  run.source = "finished";
  run.task_run = db.latest_run(s.db(), task.id, null);
  run.updated_at = now();
  save(s, run);
  background("advancing a workflow run", advance(s, run.id));
}

/**
 * The task was held in its column for a run that didn't start (or had ended): unless something else has it (a run that
 * holds it, its agent working again), it goes to "In review", as it would have without the workflow.
 */
function unheld(s: Shared, task_id: string): void {
  background(
    "moving a task on",
    (async () => {
      const t = db.get_task(s.db(), task_id);
      if (!t || t.status !== "in_progress" || t.running || t.waiting || t.merging || s.is_running(task_id)) return;
      if (running(s.db(), task_id).some((r) => r.source === "finished")) return;
      await api.update_task_inner(s, task_id, { status: "in_review" });
    })().catch((e) => s.add_event(task_id, "warn", "Couldn't move the task on after its workflow", msg(e))),
  );
}

/** The task was merged: the project's workflow with a node for Ready for merge goes on from there. */
export function on_merged(s: Shared, task: Task): void {
  if (task.kind !== "task" || !task.project_id || task.subproject) return;
  let due: Array<[Workflow, ColumnNode]> = [];
  try {
    due = columns(s.db(), task.project_id, "ready_for_merge");
  } catch (e) {
    console.error(`reading workflows for task ${task.id}: ${err_str(e)}`);
  }
  for (const [w, n] of due) {
    background(
      "starting a workflow",
      start(s, w.id, task.id, false, 0, "merged", n.id).catch((e) => s.add_event(task.id, "warn", `Couldn't run the workflow "${w.name}"`, msg(e))),
    );
  }
}

/** The project's workflow node for column `status` with the task's agent's work there, if any. */
function work_column(s: Shared, task: Task, status: string): [Workflow, ColumnNode] | null {
  if (task.kind !== "task" || !task.project_id || task.subproject) return null;
  try {
    return columns(s.db(), task.project_id, status).find(([w, n]) => agent_works(n, w.graph)) ?? null;
  } catch (e) {
    console.error(`reading workflows for task ${task.id}: ${err_str(e)}`);
    return null;
  }
}

/**
 * What the agent is told once column node `n`'s work is done, after its prompt: how to say it's done, and what the
 * board does then (see `after_done`).
 */
export function done_note(g: Graph, n: ColumnNode): string {
  const then = after_done(g, n.id);
  const finish = n.done_when === "finish";
  if (!then.length && !finish) return "";
  let p = finish
    ? "When the work you were asked for here is complete, call `finish_work`, then end your turn with a summary of what you did. A turn that ends " +
      "without it leaves the task in Needs attention."
    : "When you're done, end your turn with a summary of what you did.";
  if (then.length) p += ` The board then ${then.length === 1 ? then[0] : `${then.slice(0, -1).join(", ")} and ${then[then.length - 1]}`}.`;
  return p;
}

// ---------- values: what data wires give the inputs they go into ----------

/** Where values are read from: the graph, its workflow, the task, and the run (none before one, say for a start prompt). */
export interface Source {
  graph: Graph;
  workflow: { id: string; name: string };
  task: Task;
  key: string;
  run: Run | null;
}

function source(s: Shared, w: { id: string; name: string; graph: Graph }, task: Task, run: Run | null): Source {
  return { graph: run?.graph ?? w.graph, workflow: { id: w.id, name: w.name }, task, key: task_key(s.db(), task), run };
}

/**
 * What node `node`'s input `input` reads: the value wired into it (see `output_value`), or else its own text `own`,
 * its templates filled in.
 */
export function input_value(s: Shared, src: Source, node: Node, input: string, own: string): string {
  const e = wire(src.graph, node.id, input);
  if (!e) return prompt.render(own, src.task, src.key, src.workflow.name, src.run);
  return output_value(s, src, e.from, e.port, 0);
}

/**
 * Node `id`'s value `port`, read now: a data node's from its inputs, and a step's from what it did in the run, or else
 * in the workflow's latest run on the task that ran it (so a prompt can take the issues of the last review).
 */
function output_value(s: Shared, src: Source, id: string, port: string, depth: number): string {
  const n = graph_node(src.graph, id);
  if (!n || depth > 40) return "";
  const input = (name: string): string => {
    const e = wire(src.graph, id, name);
    return e ? output_value(s, src, e.from, e.port, depth + 1) : "";
  };
  const { task } = src;
  switch (n.kind) {
    case "agent": {
      const r = step_output(s, src, id);
      if (!r) return "";
      return port === "issues" ? prompt.numbered(r.issues ?? []) : port === "verdict" ? (r.verdict ?? "") : (r.text ?? "");
    }
    case "open_pr":
      return step_output(s, src, id)?.text ?? task.pr_url ?? "";
    case "column":
      return done_note(src.graph, n);
    case "text":
      return prompt.render(n.text, task, src.key, src.workflow.name, src.run);
    case "task":
      switch (port) {
        case "title":
          return task.title;
        case "description":
          return task.description;
        case "key":
          return src.key;
        case "branch":
          return task.branch ?? "";
        case "commit":
          return src.run?.head ?? "";
        case "pr":
          return task.pr_url ?? "";
        case "labels":
          return task.labels.join(", ");
      }
      return "";
    case "project_prompt": {
      let p: Project | null = null;
      try {
        p = task.project_id ? db.get_project(s.db(), task.project_id) : null;
      } catch {}
      return n.which === "review" ? prompts.review(p) : n.which === "merge" ? prompts.merge(p) : prompts.start(p);
    }
    case "compose": {
      const vars: Record<string, string> = {};
      for (const name of template_inputs(n.template)) if (wire(src.graph, id, name)) vars[name] = input(name);
      return prompt.render(n.template, task, src.key, src.workflow.name, src.run, vars);
    }
    case "join":
      return data_inputs(n)
        .map((i) => input(i).trim())
        .filter((t) => t)
        .join(n.separator.replaceAll("\\n", "\n"));
    case "switch":
      return input(switch_check(task, n.check, n.value ?? null) ? "yes" : "no");
  }
  return "";
}

/** A switch's check, which it makes without git: has the task a pull request, or a type or label. */
function switch_check(task: Task, check: Check, value: string | null): boolean {
  if (check === "has_pr") return !!task.pr_url?.trim();
  if (check === "task_type") return (task.task_type ?? "code") === (value ?? "code");
  if (check === "label") return value != null && task.labels.includes(value);
  return false;
}

/** What step `id` did: in the run, or else in the workflow's latest run on the task that it finished in. */
function step_output(s: Shared, src: Source, id: string): NodeRun | null {
  const now_ = src.run?.nodes[id];
  if (now_?.state === "done") return now_;
  try {
    const rows = db.all(
      s.db(),
      "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 ORDER BY rowid DESC LIMIT 20",
      src.workflow.id,
      src.task.id,
      src.run?.id ?? "",
    );
    for (const row of rows) {
      const r = JSON.parse(row.nodes)[id];
      if (r?.state === "done") return r;
    }
  } catch {}
  return null;
}

/**
 * Column node `n`'s prompt for `task` (wired, or its own with its templates filled in; `fallback` if that's empty), with
 * what to do when its work is done, unless its `next` is wired somewhere to say so.
 */
function column_text(s: Shared, task: Task, w: Workflow, n: ColumnNode, run: Run | null, fallback: string): string {
  const src = source(s, w, task, run);
  const own = input_value(s, src, n, "prompt", n.prompt).trim() || fallback;
  const placed = src.graph.edges.some((e) => e.input != null && e.from === n.id && e.port === "next");
  const note = placed ? "" : done_note(src.graph, n);
  return note && own ? `${own}\n\n${note}` : note || own;
}

/**
 * What a task's agent is told to do when it starts, if the project's workflow has an In progress node: its prompt (or
 * the project's start prompt), and what happens when it's done. Only for its code tasks, as the project's own is.
 */
export function start_instructions(s: Shared, task: Task, project: Project | null | undefined): string | null {
  if (!project || !takes_start_prompt(task)) return null;
  const found = work_column(s, task, "in_progress");
  if (!found) return null;
  const [w, n] = found;
  return column_text(s, task, w, n, null, prompts.start(project));
}

/** How the task's agent merges it, if the project's workflow's Ready for merge node has a prompt. */
export function merge_instructions(s: Shared, task: Task): string | null {
  const found = work_column(s, task, "ready_for_merge");
  if (!found) return null;
  const [w, n] = found;
  const text = input_value(s, source(s, w, task, null), n, "prompt", n.prompt).trim();
  return text || null;
}

/** Whether the project's workflow opens the task's pull request once its agent's work in In progress is done. */
export function board_opens_pr(s: Shared, task: Task): boolean {
  // Not while it merges (or steps out of the merge queue to make changes): the board pushes after In progress, and the
  // agent's merge (resolving conflicts, committing what's left) is its own to push.
  if (task.merging || task.remerge) return false;
  const found = work_column(s, task, "in_progress");
  return found != null && opens_pr(found[0].graph, found[1].id);
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
 * it's on or the task is in its column, with fresh rounds, from its start (or else its node for the task's column), and
 * says why when it can't. Otherwise it starts at node `at`, for what `on` says happened: the task entered its column
 * (`status`), its agent's work there is done (`finished`) or it was merged (`merged`). Returns the run, or null when
 * there was nothing to do.
 */
export async function start(
  s: Shared,
  workflow_id: string,
  task_id: string,
  manual: boolean,
  chain = 0,
  on: TriggerOn = "status",
  at: string | null = null,
): Promise<Run | null> {
  const release = await (STARTING ??= new AsyncMutex()).lock();
  try {
    return await start_locked(s, workflow_id, task_id, manual, chain, on, at);
  } finally {
    release();
  }
}

async function start_locked(
  s: Shared,
  workflow_id: string,
  task_id: string,
  manual: boolean,
  chain: number,
  on: TriggerOn,
  at: string | null,
): Promise<Run | null> {
  const w = get(s.db(), workflow_id);
  if (!w) throw ApiError.not_found("workflow");
  const task = db.get_task(s.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  if (task.kind !== "task" || task.project_id !== w.project_id) throw ApiError.bad("a workflow runs only on its own project's tasks");
  const project = db.get_project(s.db(), w.project_id);
  if (!project) throw ApiError.not_found("project");
  if (project.archived_at) return skip(manual, "the project is archived");
  if (!manual && !w.enabled) return null;
  const from = manual
    ? (trigger(w.graph) ?? column_node(w.graph, task.status))
    : at != null
      ? graph_node(w.graph, at)
      : column_node(w.graph, on === "finished" ? "in_progress" : on === "merged" ? "ready_for_merge" : task.status);
  if (!from) return skip(manual, `it has no start, nor a node for the task's column (${status_label(task.status)})`);
  if (!manual) {
    if (from.kind !== "column") return null;
    if (on === "status" && from.status !== task.status) return null;
    if (on === "finished" && (task.status === "done" || task.merging)) return null;
    if (on === "merged" && task.status !== "done") return null;
  }
  // Waiting at a column whose prompt the agent is sent, for that work to be done (see `on_finished`).
  const waits = !manual && on === "status" && agent_works(from, w.graph);
  // A column with nothing after it is only where lines end: entering it runs nothing (a run would hide the last
  // one's output in the task's tabs).
  if (!manual && !waits && on !== "finished" && !flow_edges(w.graph).some((e) => e.from === from.id)) return null;
  // Read before the check that it isn't running, so a run that starts in between counts as later (see below).
  const task_run = db.latest_run(s.db(), task.id, null);
  // A merge ends while the agent that merged it is still going.
  if (on !== "merged" && s.is_running(task.id)) return skip(manual, "the task's agent is still working");
  const previous = latest_run(s.db(), w.id, task.id);
  const same = running(s.db(), task.id).some((r) => r.workflow_id === w.id && Object.entries(r.nodes).some(([id, n]) => n.start && id === from.id));
  if (same) return skip(manual, "it's already running on this task");
  // Once for each time the agent finishes (a restart settles a plan task's column again, see runner::settle_plans).
  if (!manual && on === "finished" && previous != null && previous.source === "finished" && previous.task_run === task_run) return null;
  const head = task.worktree_path && task.worktree_state === "ready" ? await rev_parse(task.worktree_path, "HEAD") : null;
  const at_ = now();
  const nodes: Record<string, NodeRun> = {};
  for (const n of w.graph.nodes) {
    // Data nodes have no part in a run: they're read (see `output_value`).
    if (is_data(n)) continue;
    if (n.id !== from.id) nodes[n.id] = { state: "pending" };
    else if (waits) nodes[n.id] = { state: "running", start: true, started_at: at_ };
    else nodes[n.id] = { state: "done", port: n.kind === "trigger" ? "out" : "done", start: true, started_at: at_, finished_at: at_ };
  }
  const run: Run = {
    id: new_id(),
    workflow_id: w.id,
    task_id: task.id,
    source: manual ? "manual" : on,
    state: "running",
    head,
    task_run,
    graph: w.graph,
    nodes,
    rounds: manual ? {} : (previous?.rounds ?? {}),
    detail: null,
    created_at: at_,
    updated_at: at_,
    finished_at: null,
  };
  // The agent may have started again while git was read: `supersede` found no run to stop then.
  if (on !== "merged" && (db.later_run(s.db(), task.id, task_run ?? "") || s.is_running(task.id))) return skip(manual, "the task's agent is working again");
  insert_run(s.db(), run);
  if (chain > 0) CHAIN.set(run.id, chain);
  s.add_event(task.id, "info", `Running the workflow "${w.name}"`);
  runs_changed(s, task.id);
  if (waits && from.kind === "column") {
    try {
      runner.send_as(s, task.id, column_text(s, task, w, from, run, ""), true);
    } catch (e) {
      record(s, run.id, from.id, Done_failed(`couldn't send the agent the column's prompt: ${msg(e)}`));
    }
  }
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
      if (is_data(n) || run_node(run, n.id).state !== "pending") continue;
      const incoming = flow_edges(run.graph).filter((e) => e.to === n.id);
      // A column's `done` comes only where the run starts (waiting there until it does): others end their paths.
      const from_settled = (from: string) =>
        graph_node(run.graph, from)?.kind === "column" ? run_node(run, from).state !== "running" : settled(run_node(run, from));
      if (!incoming.every((e) => from_settled(e.from))) continue;
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

/** Ends the run once no node is left to run: its sends (and In progress) that weren't reached give their rounds back. */
function settle(run: Run): boolean {
  if (run.state !== "running" || run.graph.nodes.some((n) => !is_data(n) && !settled(run_node(run, n.id)))) return false;
  // A send this run could have reached but went another way (its review passed, say) ends its rounds in a row. One
  // past a column the run doesn't start at is the next run's: its rounds go on.
  const reach = reachable(run);
  for (const n of run.graph.nodes) {
    const counts = n.kind === "send_to_task" || (n.kind === "column" && n.status === "in_progress");
    if (counts && run_node(run, n.id).state === "skipped" && reach.has(n.id)) delete run.rounds[n.id];
  }
  run.state = "done";
  run.finished_at = now();
  run.updated_at = now();
  return true;
}

/**
 * The nodes a run can reach from where it starts: along its flow edges, up to the columns it moves the task to (whose
 * outcomes are the next run's).
 */
export function reachable(run: Run): Set<string> {
  const from = start_node(run);
  const seen = new Set<string>();
  if (!from) return seen;
  const edges = flow_edges(run.graph);
  const stack = [from.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id !== from.id && graph_node(run.graph, id)?.kind === "column") continue;
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
  return seen;
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
    if (!run || run.state !== "running") {
      CHAIN.delete(run_id);
      return;
    }
    const ready = plan(run);
    const ended = settle(run);
    save(s, run);
    if (ended) {
      CHAIN.delete(run_id);
      ended_run(s, run);
      return;
    }
    if (!ready.length) return;
    for (const id of ready) {
      const node = graph_node(run.graph, id);
      if (!node) continue;
      let done: Done | null = null;
      switch (node.kind) {
        case "trigger":
          done = Done_port("out");
          break;
        case "condition":
          try {
            done = Done_port((await condition(s, run, node.id, node.check, node.value ?? null)) ? "yes" : "no");
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
        case "column":
          done = await enter_column(s, run, node);
          break;
        case "open_pr":
          try {
            done = await open_pr(s, run, node);
          } catch (e) {
            done = Done_failed(typeof e === "string" ? e : msg(e));
          }
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
  release(s, run);
}

/**
 * A run that its task's agent finishing started (HA-276) has ended: the task, held in its column for it, moves on if
 * the run left it there idle (it had no move step, or a step before one failed, or it was stopped). It goes to "In
 * review", as it would have without the workflow, or to "Needs attention" saying why when a step failed or the run was
 * stopped. Left alone once it has moved, its agent has started again, or another such run is still going on it.
 */
export function release(s: Shared, run: Run, why: string | null = null): void {
  if (run.source !== "finished") return;
  let task: Task | null;
  try {
    const c = s.db();
    task = db.get_task(c, run.task_id);
    if (!task || task.status !== "in_progress" || task.running || task.waiting || task.merging || s.is_running(task.id)) return;
    if (db.later_run(c, task.id, run.task_run ?? "")) return;
    if (running(c, task.id).some((r) => r.source === "finished" && r.id !== run.id)) return;
  } catch (e) {
    console.error(`task ${run.task_id}: after its workflow: ${err_str(e)}`);
    return;
  }
  let name = "";
  try {
    name = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const failed = run.graph.nodes.find((n) => run_node(run, n.id).state === "failed");
  const reason =
    why != null
      ? `The workflow "${name}" ${why}`
      : run.state === "stopped"
        ? `The workflow "${name}" was stopped before it moved the task${run.detail ? `: ${run.detail}` : ""}`
        : failed
          ? `The workflow "${name}" failed at ${node_name(failed)}: ${(run_node(run, failed.id).text ?? "").split("\n")[0]}`
          : null;
  const id = task.id;
  background(
    "moving a task on after its workflow",
    (async () => {
      // Still as it was: nothing moved it while this waited.
      const t = db.get_task(s.db(), id);
      if (!t || t.status !== "in_progress" || t.running || s.is_running(id) || db.later_run(s.db(), id, run.task_run ?? "")) return;
      if (reason == null) {
        s.add_event(id, "info", `The workflow "${name}" ended without moving the task, so it goes to In review`);
        // Back in the column whose work this was, which isn't started again (see `on_status`).
        const from = start_node(run);
        const quiet = from?.kind === "column" && from.status === "in_review" ? `${id}|${run.workflow_id}|${from.id}` : null;
        if (quiet) QUIET.add(quiet);
        try {
          await api.update_task_inner(s, id, { status: "in_review" });
        } finally {
          if (quiet) QUIET.delete(quiet);
        }
      } else {
        await api.update_task_inner(s, id, { status: "needs_attention" });
        attention(s, id, reason);
      }
    })().catch((e) => s.add_event(id, "warn", "Couldn't move the task on after its workflow", msg(e))),
  );
}

/** The node a run started at. */
function start_node(run: Run): Node | undefined {
  const id = Object.keys(run.nodes).find((k) => run.nodes[k].start);
  return id != null ? graph_node(run.graph, id) : undefined;
}

/** Gives a task in "Needs attention" its reason, unless it has moved on meanwhile. */
function attention(s: Shared, task_id: string, reason: string): void {
  s.update_task_if(task_id, [["attention_reason", reason]], (c) => db.get_task(c, task_id)?.status === "needs_attention");
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
    case "open_pr":
      return "Open a pull request";
    case "column":
      return status_label(n.status);
    default:
      return n.kind;
  }
}

/** The last finished run of the same workflow on the same task before `run`, in which node `node_id` ran. */
function last_done(c: Conn, run: Run, node_id: string): Run | null {
  // A run from another column (In progress's, which moves the task to In review, say) may not have reached the node:
  // the last one that ran it is the one to compare with.
  const rows = db.all(
    c,
    "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 AND state='done' ORDER BY rowid DESC LIMIT 20",
    run.workflow_id,
    run.task_id,
    run.id,
  );
  for (const row of rows) {
    const st = JSON.parse(row.nodes)[node_id]?.state;
    if (st != null && st !== "pending" && st !== "skipped") return Run_from_row(row);
  }
  return null;
}

/** A check on the task. Throws a string saying why it couldn't be made. */
async function condition(s: Shared, run: Run, node_id: string, check: Check, value: string | null): Promise<boolean> {
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
      // No worktree or branch (a scratch task, one that makes only documents, a project without worktrees): none.
      if (!task.branch || !task.worktree_path || task.worktree_state !== "ready") return false;
      return !(await elsewhere(s, task))[1];
    case "changed": {
      // A run by hand is asked for whatever changed.
      if (run.source === "manual") return true;
      // Since the latest of its runs on the task that finished, and got as far as this check.
      let last: Run | null;
      try {
        last = last_done(s.db(), run, node_id);
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
  // What the steps before it in the graph said.
  const earlier: Array<[string, string]> = [];
  for (const n of upstream(run.graph, node.id)) {
    if (n.kind !== "agent") continue;
    const r = run.nodes[n.id];
    if (r?.state === "done" && r.text != null) earlier.push([n.name, r.text]);
  }
  const replies = output === "verdict" ? history.user_replies(s.db(), task.id, review.REPLIES) : null;
  const existing = thread_for(s, run, node.id, config_id, model, effort);
  // Issues it found last time, if the agent was sent them since.
  let recheck: string[] = [];
  if (output === "verdict" && Object.keys(run.rounds).length) {
    const last = last_done(s.db(), run, node.id);
    const n = last?.nodes[node.id];
    if (n?.port === "issues") recheck = n.issues ?? [];
  }
  const rendered = input_value(
    s,
    { graph: run.graph, workflow: { id: run.workflow_id, name: workflow }, task, key: work.key, run },
    node,
    "prompt",
    instructions,
  );
  const asked = rendered.trim() ? rendered : output === "verdict" ? prompts.review(project) : `Read the work, and report on it as "${name}".`;
  const text = prompt.agent(task, work, workflow, name, asked, output, skills, codex, earlier, replies, recheck, node.input_only === true);
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
  db.set_thread_disabled_mcp_servers(s.db(), thread.id, node.disabled_mcp_servers ?? []);
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
  let text = input_value(s, { graph: run.graph, workflow: { id: run.workflow_id, name: workflow }, task, key, run }, node, "message", message).trim();
  if (!text) {
    if (!issues.length) return Done_failed("there are no issues to send (and the step has no message of its own)");
    text = prompt.fixes(workflow, issues);
  }
  text = with_finish(s, task, text);
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
  CHAIN.delete(current.id);
  for (const t of threads) runner.stop(s, t);
  try {
    runner.send_fixes(s, task.id, text, round);
  } catch (e) {
    s.add_event(task.id, "error", `The workflow "${workflow}" couldn't send its message to the agent`, msg(e));
    release(s, current, `couldn't send its message to the agent: ${msg(e).split("\n")[0]}`);
  }
  return null;
}

/** Marks a run's nodes still to run as skipped and those running as stopped, saying `why`. Returns the threads to stop. */
function end_nodes(run: Run, why: string): string[] {
  const threads: string[] = [];
  const at = now();
  for (const n of run.graph.nodes) {
    if (is_data(n)) continue;
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

/**
 * An edge into a column node: moves the task there, where the column's node starts the next run (see `on_status`). In
 * In progress the agent is given its work, which ends the run as a send does: a task that hasn't started starts, and
 * one that has is sent the issues the run found, or else the column's prompt.
 */
async function enter_column(s: Shared, run: Run, node: Node): Promise<Done | null> {
  if (node.kind !== "column") return Done_failed("not a column");
  let task = db.get_task(s.db(), run.task_id);
  if (!task) return Done_failed("the task is gone");
  // Each time in a row this gives the agent its work is a round, as a send's are: a line round through the columns
  // (a review that keeps finding issues, say) ends in Needs attention once they're used up.
  const used = node.status === "in_progress" ? (run.rounds[node.id] ?? 0) : 0;
  const max_rounds = node.max_rounds ?? COLUMN_ROUNDS;
  if (node.status === "in_progress" && used >= max_rounds) return out_of_rounds(s, run, task, used);
  if (task.status !== node.status) {
    const moved = await move_task(s, run, node.status);
    if (moved.state === "failed") return moved;
    task = db.get_task(s.db(), run.task_id);
    if (!task) return Done_failed("the task is gone");
  }
  if (node.status !== "in_progress" || task.status !== "in_progress" || task.waiting || task.merging || s.is_running(task.id)) return Done_port_none();
  const w = get(s.db(), run.workflow_id);
  const issues = prompt.issues(run);
  // A prompt that's wired is the one to send, which can take the issues itself; else the issues, or else In progress's
  // start text, as the agent started with (its prompt, or the project's start prompt): the task isn't left in In
  // progress with nothing to do.
  const wired = wire(run.graph, node.id, "prompt") != null;
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  const text =
    task.session_id == null
      ? ""
      : !w
        ? null
        : issues.length && !wired
          ? with_finish(s, task, prompt.fixes(w.name, issues))
          : column_text(s, task, w, node, run, prompts.start_task(task, project));
  if (text == null) return Done_port_none();
  // Ends the run, and stops its other steps: the agent's work is about to change.
  const current = get_run(s.db(), run.id);
  if (!current || current.state !== "running") return null;
  const at = now();
  current.rounds[node.id] = used + 1;
  const r = node_entry(current, node.id);
  r.state = "done";
  delete r.port;
  r.finished_at = at;
  const threads = end_nodes(current, "Stopped because the task's agent was given its work.");
  current.state = "done";
  current.finished_at = at;
  current.updated_at = at;
  save(s, current);
  CHAIN.delete(current.id);
  for (const t of threads) runner.stop(s, t);
  try {
    runner.send_as(s, task.id, text, true);
  } catch (e) {
    s.add_event(task.id, "error", `The workflow "${w?.name ?? ""}" couldn't give the agent its work`, msg(e));
  }
  return null;
}

/**
 * An edge into In progress with no rounds left: the task isn't moved, and goes to Needs attention with the issues the
 * run found (unless the user or its agent has moved on).
 */
function out_of_rounds(s: Shared, run: Run, task: Task, used: number): Done {
  let workflow = "";
  try {
    workflow = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const issues = prompt.issues(run);
  const n = issues.length;
  const times = used === 1 ? "once" : `${used} times`;
  const reason =
    n === 0
      ? `The workflow "${workflow}" gave the agent its work ${times} in a row, as many as it can`
      : `The workflow "${workflow}" found ${n} serious issue${n === 1 ? "" : "s"} after ${used === 1 ? "a round" : `${used} rounds`} of fixes`;
  s.add_event(task.id, "warn", reason, n ? issues.join("\n\n") : null);
  if (!s.is_running(task.id) && task.status !== "done" && !task.merging) {
    try {
      s.update_task(task.id, [
        ["status", "needs_attention"],
        ["attention_reason", reason],
      ]);
    } catch (e) {
      console.error(`flagging a task: ${err_str(e)}`);
    }
  }
  return Done_failed("out of rounds: the agent was given its work as many times in a row as the column allows");
}

/** A node that ended without an outcome: a column, whose outcome is the next run's. */
const Done_port_none = (): Done => ({ state: "done", port: null, text: null });

async function move_task(s: Shared, run: Run, status: string): Promise<Done> {
  const key = { task: run.task_id, workflow: run.workflow_id, chain: CHAIN.get(run.id) ?? 0 };
  MOVING.push(key);
  try {
    await api.update_task_inner(s, run.task_id, { status });
    // Why it needs attention: the steps of the run that failed, or else that the workflow moved it there.
    if (status === "needs_attention") {
      let name = "";
      try {
        name = get(s.db(), run.workflow_id)?.name ?? "";
      } catch {}
      const current = get_run(s.db(), run.id) ?? run;
      const failed = current.graph.nodes
        .filter((n) => run_node(current, n.id).state === "failed")
        .map((n) => `${node_name(n)}: ${run_node(current, n.id).text ?? ""}`);
      const reason = failed.length ? `The workflow "${name}" failed at ${failed[0].split("\n")[0]}` : `The workflow "${name}" moved it here`;
      attention(s, run.task_id, reason);
    }
    return Done_port("out");
  } catch (e) {
    return Done_failed(msg(e));
  } finally {
    MOVING.splice(MOVING.indexOf(key), 1);
  }
}

/** Hooks for tests: what `open_pr` finds the task's GitHub repository to be, in place of its remotes. */
export const engine_testing = { GITHUB: null as worktree.Github | null };

/** The first `https://` URL in gh's output: the pull request it made (or the one that's there already). */
function pr_link(out: string): string | null {
  return out.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
}

/**
 * An open-a-pull-request step: pushes the task's branch and opens its pull request with the gh tools, as the task's
 * GitHub account, into its base branch. Throws a string saying why it couldn't.
 */
async function open_pr(s: Shared, run: Run, node: Node): Promise<Done> {
  if (node.kind !== "open_pr") return Done_failed("not a pull request step");
  const task = db.get_task(s.db(), run.task_id);
  if (!task) throw "the task is gone";
  const has = task.pr_url?.trim() ? { state: "done", port: "exists", text: task.pr_url } : null;
  // One it has already gets its branch's new commits.
  if (has && (!task.branch || !task.worktree_path || task.worktree_state !== "ready")) return has;
  const project = task.project_id ? db.get_project(s.db(), task.project_id) : null;
  if (!project) throw "the task has no project";
  const [work, is_elsewhere] = await elsewhere(s, task);
  if (is_elsewhere && has) return has;
  if (is_elsewhere) throw "the task's branch has no commits of its own to open a pull request for";
  const dir = task.worktree_path!;
  const branch = task.branch!;
  const base = await worktree.remote_base(s, task, project);
  const gh = engine_testing.GITHUB ?? (await worktree.github(project.repo_path, base));
  if (!gh) throw "the task's repository isn't on GitHub (no remote to push to there)";
  const account_name = runner.task_github_account(s, task);
  const account = account_name ? gh_mcp.Account.parse(account_name) : null;
  if (account_name && !account) throw `the GitHub account ${account_name} isn't one gh can use`;
  const r: gh_mcp.GhRun = { cwd: dir, account, merge_gate: async () => null };
  const call = async (tool: string, args: any): Promise<[string, boolean]> => {
    try {
      return await gh_mcp.run(tool, args, r);
    } catch (e) {
      return [msg(e), true];
    }
  };
  let workflow = "";
  try {
    workflow = get(s.db(), run.workflow_id)?.name ?? "";
  } catch {}
  const [pushed, push_failed] = await call("git_push", { remote: gh.remote, branch });
  if (push_failed) throw `couldn't push ${branch} to ${gh.remote}: ${pushed}`;
  if (has) return has;
  const src: Source = { graph: run.graph, workflow: { id: run.workflow_id, name: workflow }, task, key: work.key, run };
  const title = input_value(s, src, node, "title", node.title).trim() || `${work.key}: ${task.title}`;
  const body = input_value(s, src, node, "body", node.body).trim() || history.last_assistant_text(s.db(), task.id)?.trim() || task.description.trim();
  const args: any = { repo: gh.repo, head: branch, title, body: body || title };
  if (base) args.base = base;
  if (node.draft) args.draft = true;
  const [out, failed] = await call("pr_create", args);
  const url = pr_link(out);
  // Opened meanwhile (by the agent, or by hand): gh says so, with its link.
  const exists = failed && /already exists/i.test(out);
  if (!url || (failed && !exists)) throw `couldn't open the pull request: ${out}`;
  if (!db.get_task(s.db(), task.id)?.pr_url) s.update_task(task.id, [["pr_url", url]]);
  s.add_event(task.id, "info", exists ? `The workflow "${workflow}" found the task's pull request` : `The workflow "${workflow}" opened a pull request`, url);
  return { state: "done", port: exists ? "exists" : "opened", text: url };
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
    const id = Object.keys(r.nodes)
      .sort()
      .find((k) => r.nodes[k].state === "running" && r.nodes[k].thread_id === thread.id);
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
    ? si
        .filter((i: any) => typeof i === "string")
        .map((i: string) => i.trim())
        .filter((i: string) => i)
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
export function stop_run(s: Shared, run_id: string, why: string, move_on = true): boolean {
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
  CHAIN.delete(run.id);
  for (const t of threads) runner.stop(s, t);
  // Not when its agent has started again: the task is that run's now.
  if (move_on) release(s, run);
  return true;
}

function stop_all(s: Shared, task_id: string, why: string, move_on = true, keep_waiting = false): boolean {
  let rs: Run[] = [];
  try {
    rs = running(s.db(), task_id);
  } catch {}
  let any = false;
  for (const r of rs) if (!keep_waiting || !waiting_column(r)) any = stop_run(s, r.id, why, move_on) || any;
  return any;
}

/**
 * The task's agent started working again: its workflows' runs in progress are out of date, but those waiting for its
 * work in a column (see `waiting_column`), which this may be.
 */
export function supersede(s: Shared, task: Task): void {
  stop_all(s, task.id, "Stopped because the agent started working on the task again.", false, true);
}

/** Stops workflow `workflow_id`'s runs that wait for the work of a column (it's off, say). */
export function stop_waiting(s: Shared, workflow_id: string, why: string): void {
  let rs: Run[] = [];
  try {
    rs = running(s.db(), null);
  } catch {}
  for (const r of rs) if (r.workflow_id === workflow_id && waiting_column(r)) stop_run(s, r.id, why);
}

/** The user stopped the task: stop its workflows' runs too. Returns whether any was running. */
export function stop(s: Shared, task_id: string): boolean {
  const stopped = stop_all(s, task_id, "Stopped by the user.");
  if (stopped) s.add_event(task_id, "warn", "Workflow stopped");
  return stopped;
}

/**
 * On start (after `runner.load_active`): steps that were running on the board itself when the server stopped failed,
 * and the runs go on from there. So did agent steps whose agent isn't running: the server stopped while the step was
 * starting it (reading the task's git, before its thread had a run), so nothing would end them.
 */
export function resume(s: Shared): void {
  let rs: Run[] = [];
  try {
    rs = running(s.db(), null);
  } catch {}
  for (const run of rs) {
    let changed = false;
    for (const n of run.graph.nodes) {
      if (is_data(n)) continue;
      const r = node_entry(run, n.id);
      if (r.state !== "running") continue;
      // Agents carry on over a restart, and their runs' ends end their steps (see `finished`), as the task's agent's
      // do a column's whose work it was given.
      if (n.kind === "agent" && r.thread_id && s.is_running(r.thread_id)) continue;
      if (n.kind === "column" && r.start) continue;
      r.state = "failed";
      r.port = "failed";
      r.text = n.kind === "agent" ? "Interrupted: the server stopped before this step's agent started." : "Interrupted: the server stopped while this ran.";
      r.finished_at = now();
      changed = true;
    }
    if (changed) save(s, run);
  }
  for (const run of rs) background("resuming a workflow run", advance(s, run.id));
}
