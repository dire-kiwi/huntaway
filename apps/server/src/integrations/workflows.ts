// Port of server/src/integrations/workflows.rs (HA-173's branch, ported by HA-189).
/**
 * Workflows: a project's automations that act on its tasks, as graphs of nodes (HA-173, API 107): since HA-276 (API
 * 127), a task's whole way across the board, column by column.
 *
 * A **column** node starts a run on a task that enters its column. Its prompt is what the task's agent is sent then,
 * with what the board does once that work is done: for In progress, the task's start prompt (an edge into In progress
 * gives a started task the issues the run found, or else the prompt), and for Ready for merge, its merge instructions.
 * Where the agent works (In progress, Ready for merge, a column with a prompt), the run waits for that work to be done:
 * the agent's run ending (a question for the user, or a failure, leaves the task in Needs attention meanwhile), or,
 * with `done_when: finish`, its saying so with `finish_work`; for Ready for merge, the task's merge. Then it goes on
 * from the column's `done`, and the task stays in its column rather than going to *In review*: the workflow moves it on,
 * or `release` does once the run ends. Elsewhere `done` follows at once. An edge into a column node moves the task
 * there, which ends that path of the run: what comes after the column is the next run's. The **trigger** node starts a
 * run by hand (`POST /workflows/{id}/run`, `run_workflow`); a workflow without one is run by hand from its node for the
 * task's column. From there the run follows the graph's edges, out of the **port** each node ends on:
 *
 * - a **condition** checks the task (`yes` or `no`): has its work changed since the workflow last ran on it, has
 *   its branch commits of its own, has it a pull request, or a type or label;
 * - an **agent** step runs an agent in a thread of its own, read-only in the task's worktree, as a reviewer does
 *   (a `review` thread of type `workflow` whose parent is the task, kept from one run to the next). Its output is
 *   its last message (`done`), or a verdict it reports with `submit_review` (`pass` or `issues`), or it `failed`.
 *   With a `tab`, its output shows in a tab of that name in the task's panel. It's given the output of the agent steps
 *   before it in the graph (those with a path to it), and with `input_only` only that and its prompt, not the task's
 *   work, so a step can process another's output (a summary, say) with a skill in a fresh context;
 * - **open a pull request** for the task's branch, which the board does itself (pushing the branch and creating it
 *   with the gh tools, as the task's GitHub account): `opened`, `exists` (the task has one already, which gets the
 *   branch's new commits) or `failed`. Its title and body are templates, so an agent step before it can write them;
 * - **send to the task's agent** sends a message (by default the issues the run's agents found) to the task's
 *   agent: at most `max_rounds` runs in a row (`sent`), then `exhausted`, which with nothing after it leaves the
 *   task in *Needs attention*. Sending ends the run, as the agent's work changes under it.
 *
 * A node runs once every node with an edge into it has finished, when one of those edges was taken (`join: any`,
 * the default) or all of them (`join: all`); otherwise it's skipped, and so are the nodes only it leads to. Nodes
 * with several outputs side by side run at once, so two agent steps after a column review together. A graph has a
 * node for each column at most, and a column where the agent works belongs to one workflow that's on.
 *
 * A run keeps the graph as it was when it started, so changing a workflow doesn't change runs in progress. A run in
 * progress is stopped when the task's agent starts working again (its work is changing), but one waiting for that
 * work in a column, or when the task is stopped. Graphs from before column nodes (a trigger on a column or on the
 * agent finishing, and `set_status` moves) are read as column nodes.
 */
import * as db from "../db.ts";
import type { Conn, Project } from "../db.ts";
import { de_def_str, de_opt_str, de_str, de_uint } from "../db/task_data.ts";
import { ApiError } from "../http.ts";
import * as permissions from "../mcp/permissions.ts";
import type { Shared } from "../state.ts";
import { err_str, new_id, now } from "../util.ts";
import * as engine from "./workflows/engine.ts";

export * from "./workflows/engine.ts";
export * from "./workflows/handlers.ts";

/** The task type of a workflow's agent thread. */
export const WORKFLOW = "workflow";
/** Most nodes a workflow can have, and agent steps among them. */
export const MAX_NODES = 80;
export const MAX_AGENTS = 8;
/** Most rounds a send (or an edge into In progress) can be given. */
export const MAX_ROUNDS = 20;
/** How many times in a row edges into In progress give the task's agent its work, for a column node without `max_rounds`. */
export const COLUMN_ROUNDS = 3;
const MAX_TEXT = 20_000;

// ---------- what a workflow is ----------

export type Join = "any" | "all";
/**
 * What a run starts from: the task entering a column node's column (`status`), its agent finishing the work it was
 * given there (`finished`), its merge (`merged`), or a run by hand (`manual`).
 */
export type TriggerOn = "status" | "finished" | "merged" | "manual";
/** When a column node's work is done: when the agent's run ends (`run_end`), or when it calls `finish_work` (`finish`). */
export type DoneWhen = "run_end" | "finish";
/**
 * `changed`: the workflow hasn't finished a run on the task, or its commit or its agent's work changed since.
 * `has_commits`: its branch has commits of its own. `has_pr`: it has a pull request. `task_type`: it's of type `value`
 * (`code` for a code task). `label`: it has label `value`.
 */
export type Check = "changed" | "has_commits" | "has_pr" | "task_type" | "label";
/** `text`: its last message. `verdict`: `pass` or `issues`, reported with `submit_review`. */
export type Output = "text" | "verdict";

/** What a trigger node can be: before HA-276's column nodes, `status` and `finished` too, which are read as column nodes. */
const TRIGGER_ONS = ["status", "finished", "manual"];
const DONE_WHENS: DoneWhen[] = ["run_end", "finish"];
const CHECKS: Check[] = ["changed", "has_commits", "has_pr", "task_type", "label"];
const OUTPUTS: Output[] = ["text", "verdict"];
const KINDS = [
  "trigger",
  "condition",
  "agent",
  "send_to_task",
  "set_status",
  "open_pr",
  "column",
  "text",
  "task",
  "project_prompt",
  "compose",
  "join",
  "switch",
];
/** The kinds of data nodes, which only give values to other nodes' inputs (see `data_outputs`): no run reaches them. */
export const DATA_KINDS = ["text", "task", "project_prompt", "compose", "join", "switch"];
/** The checks a switch makes, which it can make without reading git. */
const SWITCH_CHECKS: Check[] = ["has_pr", "task_type", "label"];
/** Most inputs a join takes. */
const MAX_JOIN = 8;

export type NodeKind =
  /** A run by hand (`POST /workflows/{id}/run`). Its `on: status` and `on: finished` from before are read as column nodes. */
  | { kind: "trigger"; on: "manual" }
  /**
   * A column of the board (HA-276). A task entering it starts a run here, and `prompt` is what the task's agent is
   * sent then (see `agent_works`): for In progress, it's the task's start prompt, and for Ready for merge its merge
   * instructions. Its `done` port is when that work is done: the agent's run ending (or, with `done_when: finish`, its
   * calling `finish_work`), its merge, or straight away where the agent has no work. An edge into it moves the task
   * there, which ends that path of the run: what comes after the column is the next run's. An edge into In progress
   * gives the agent its work again, at most `max_rounds` times in a row (`COLUMN_ROUNDS` without it), as a send does.
   */
  | { kind: "column"; status: string; prompt: string; done_when?: DoneWhen; max_rounds?: number }
  /** A check on the task: `yes` or `no`. `value` is the type or label for `task_type` and `label`. */
  | { kind: "condition"; check: Check; value?: string }
  /**
   * An agent in a thread of its own, read-only in the task's worktree. `name` is what it's called on the board, `prompt`
   * what it's asked to do (the board adds where the work is and how to report), no `claude_config_id` uses the task's,
   * `skills` are skills it's asked to use, and `tab` the task panel tab its output shows in, if any. `input_only`: it's
   * given only the output of the steps before it and its prompt, not where the task's work is.
   */
  | {
      kind: "agent";
      name: string;
      prompt: string;
      output: Output;
      claude_config_id?: string;
      model?: string;
      effort?: string;
      skills?: string[];
      tab?: string;
      input_only?: boolean;
    }
  /** A message to the task's agent; empty sends the issues the run's agent steps found. */
  | { kind: "send_to_task"; message: string; max_rounds: number }
  /** Moves the task to another column: from before HA-276, and read as a column node. */
  | { kind: "set_status"; status: string }
  // Data nodes (HA-276): values for other nodes' inputs, read when the node they go into runs (see engine.input_value).
  /** Text, its templates filled in. */
  | { kind: "text"; text: string }
  /** The task's title, description, key, branch, commit, pull request and labels. */
  | { kind: "task" }
  /** The project's start, review or merge prompt (or the board's, if it has none). */
  | { kind: "project_prompt"; which: "start" | "review" | "merge" }
  /** A template whose `{{name}}`s (without a dot) are inputs, and fall back to the template's own values unwired. */
  | { kind: "compose"; template: string }
  /** Its inputs `in1`… (`count` of them), those with text, with `separator` between them. */
  | { kind: "join"; separator: string; count: number }
  /** Its input `yes` or `no`, by a check on the task. */
  | { kind: "switch"; check: Check; value?: string }
  /**
   * Opens a pull request for the task's branch: `title` and `body` are templates (empty: the task's key and title, and
   * its agent's last message), and `draft` opens it as a draft.
   */
  | { kind: "open_pr"; title: string; body: string; draft?: boolean };

/** A node: its id, its kind's fields (flattened), `join` (left out when `any`) and where the editor draws it. */
export type Node = { id: string } & NodeKind & { join?: Join; x: number; y: number };

/**
 * An edge from `from`'s `port` to `to`: the way a run goes. With `input`, it's a data wire instead: `from`'s data output
 * `port` (see `data_outputs`) gives `to`'s input `input` its value.
 */
export interface Edge {
  from: string;
  port: string;
  to: string;
  input?: string;
}

/** A workflow's nodes and the edges between them. */
export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

function fail(msg: string): never {
  throw new Error(msg);
}

function de_f64(v: any, k: string): number {
  const x = v[k];
  if (x === undefined) return 0;
  if (typeof x !== "number") fail(`invalid type for \`${k}\`: expected f64`);
  return x;
}

function de_bool(v: any, k: string): boolean {
  const x = v[k];
  if (x == null) return false;
  if (typeof x !== "boolean") fail(`invalid type for \`${k}\`: expected a boolean`);
  return x;
}

function de_enum<T extends string>(v: any, k: string, values: T[], def?: T): T {
  const x = v[k];
  if (x === undefined && def !== undefined) return def;
  if (x === undefined) fail(`missing field \`${k}\``);
  if (!values.includes(x)) fail(`unknown variant \`${x}\`, expected one of ${values.map((s) => `\`${s}\``).join(", ")}`);
  return x;
}

/** Sets an optional field only when it's set (serde's `skip_serializing_if = "Option::is_none"`). */
function put(o: any, k: string, x: any) {
  if (x != null) o[k] = x;
}

/** Serde's deserialization of a `Node`: its kind's fields are checked, defaulted and laid out as serde writes them. */
export function Node_from_json(v: any): Node {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("invalid type: expected struct Node");
  const id = de_str(v, "id");
  const kind = de_enum(v, "kind", KINDS as any) as NodeKind["kind"];
  const n: any = { id, kind };
  switch (kind) {
    case "trigger": {
      const on = de_enum(v, "on", TRIGGER_ONS as any);
      const status = de_opt_str(v, "status");
      // From before column nodes: a start on a column, or on the agent finishing (in In progress), is that column's node.
      if (on === "status" && status == null) fail("a start on a column needs its column (`status`)");
      if (on === "status") Object.assign(n, { kind: "column", status, prompt: "" });
      else if (on === "finished") Object.assign(n, { kind: "column", status: "in_progress", prompt: "" });
      else n.on = "manual";
      break;
    }
    case "column":
      n.status = de_str(v, "status");
      n.prompt = de_def_str(v, "prompt");
      if (de_enum(v, "done_when", DONE_WHENS, "run_end") === "finish") n.done_when = "finish";
      if (v.max_rounds !== undefined) n.max_rounds = de_uint(v, "max_rounds");
      break;
    case "condition":
      n.check = de_enum(v, "check", CHECKS);
      put(n, "value", de_opt_str(v, "value"));
      break;
    case "agent": {
      n.name = de_str(v, "name");
      n.prompt = de_def_str(v, "prompt");
      n.output = de_enum(v, "output", OUTPUTS, "text");
      put(n, "claude_config_id", de_opt_str(v, "claude_config_id"));
      put(n, "model", de_opt_str(v, "model"));
      put(n, "effort", de_opt_str(v, "effort"));
      const skills = v.skills === undefined ? [] : Array.isArray(v.skills) ? v.skills : fail("invalid type for `skills`: expected a sequence");
      for (const s of skills) if (typeof s !== "string") fail("invalid type for `skills`: expected a string");
      if (skills.length) n.skills = [...skills];
      put(n, "tab", de_opt_str(v, "tab"));
      if (de_bool(v, "input_only")) n.input_only = true;
      break;
    }
    case "send_to_task":
      n.message = de_def_str(v, "message");
      n.max_rounds = v.max_rounds === undefined ? 2 : de_uint(v, "max_rounds");
      break;
    case "set_status":
      // A move is an edge into the column's node.
      Object.assign(n, { kind: "column", status: de_str(v, "status"), prompt: "" });
      break;
    case "open_pr":
      n.title = de_def_str(v, "title");
      n.body = de_def_str(v, "body");
      if (de_bool(v, "draft")) n.draft = true;
      break;
    case "text":
      n.text = de_def_str(v, "text");
      break;
    case "task":
      break;
    case "project_prompt":
      n.which = de_enum(v, "which", ["start", "review", "merge"], "start");
      break;
    case "compose":
      n.template = de_def_str(v, "template");
      break;
    case "join":
      n.separator = v.separator === undefined ? "\n\n" : de_str(v, "separator");
      n.count = v.count === undefined ? 2 : de_uint(v, "count");
      break;
    case "switch":
      n.check = de_enum(v, "check", CHECKS);
      put(n, "value", de_opt_str(v, "value"));
      break;
  }
  const join = de_enum<Join>(v, "join", ["any", "all"], "any");
  if (join !== "any") n.join = join;
  n.x = de_f64(v, "x");
  n.y = de_f64(v, "y");
  return n;
}

function Edge_from_json(v: any): Edge {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("invalid type: expected struct Edge");
  const e: Edge = { from: de_str(v, "from"), port: v.port === undefined ? "out" : de_str(v, "port"), to: de_str(v, "to") };
  const input = de_opt_str(v, "input");
  if (input != null) e.input = input;
  return e;
}

export function Graph_from_json(v: any): Graph {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("invalid type: expected struct Graph");
  const seq = (k: string): any[] => (v[k] === undefined ? [] : Array.isArray(v[k]) ? v[k] : fail(`invalid type for \`${k}\`: expected a sequence`));
  const nodes = seq("nodes").map(Node_from_json);
  const edges = seq("edges").map(Edge_from_json);
  // The `out` of a start or a move read as a column node is its `done`.
  const read_as_column = new Set(
    seq("nodes")
      .filter((n: any) => n?.kind === "set_status" || (n?.kind === "trigger" && n?.on !== "manual"))
      .map((n: any) => n.id),
  );
  for (const e of edges) if (e.input == null && e.port === "out" && read_as_column.has(e.from)) e.port = "done";
  return { nodes, edges };
}

/** Whether it's a data node (see `DATA_KINDS`). */
export function is_data(n: NodeKind): boolean {
  return DATA_KINDS.includes(n.kind);
}

/** The graph's edges that a run goes along, without its data wires. */
export function flow_edges(g: Graph): Edge[] {
  return g.edges.filter((e) => e.input == null);
}

/** The data wire into node `id`'s input `input`, if it has one. */
export function wire(g: Graph, id: string, input: string): Edge | undefined {
  return g.edges.find((e) => e.to === id && e.input === input);
}

/** The inputs a node takes values on: its text fields, which a wire replaces (see engine.input_value). */
export function data_inputs(n: NodeKind): string[] {
  switch (n.kind) {
    case "column":
      return n.status === "needs_attention" || n.status === "done" ? [] : ["prompt"];
    case "agent":
      return ["prompt"];
    case "send_to_task":
      return ["message"];
    case "open_pr":
      return ["title", "body"];
    case "compose":
      return template_inputs(n.template);
    case "join":
      return Array.from({ length: Math.min(Math.max(n.count, 1), MAX_JOIN) }, (_, i) => `in${i + 1}`);
    case "switch":
      return ["yes", "no"];
    default:
      return [];
  }
}

/** The `{{name}}`s of a compose node's template that are inputs: those without a dot, in order. */
export function template_inputs(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The values a node gives other nodes' inputs. */
export function data_outputs(n: NodeKind): string[] {
  switch (n.kind) {
    case "agent":
      return ["text", "issues", "verdict"];
    case "open_pr":
      return ["url"];
    case "column":
      return ["next"];
    case "task":
      return ["title", "description", "key", "branch", "commit", "pr", "labels"];
    case "text":
    case "project_prompt":
    case "compose":
    case "join":
    case "switch":
      return ["text"];
    default:
      return [];
  }
}

/** The ports a node of this kind can end on. */
export function ports(n: NodeKind): string[] {
  if (is_data(n)) return [];
  switch (n.kind) {
    case "trigger":
    case "set_status":
      return ["out"];
    case "column":
      return ["done"];
    case "condition":
      return ["yes", "no"];
    case "agent":
      return n.output === "verdict" ? ["pass", "issues", "failed"] : ["done", "failed"];
    case "send_to_task":
      return ["sent", "exhausted"];
    case "open_pr":
      return ["opened", "exists", "failed"];
    default:
      return [];
  }
}

export function graph_node(g: Graph, id: string): Node | undefined {
  return g.nodes.find((n) => n.id === id);
}

export function trigger(g: Graph): Node | undefined {
  return g.nodes.find((n) => n.kind === "trigger");
}

export type ColumnNode = Node & { kind: "column" };

/** The graph's node for column `status`: a graph has one for each column at most (an older one's first counts). */
export function column_node(g: Graph, status: string): ColumnNode | undefined {
  return g.nodes.find((n): n is ColumnNode => n.kind === "column" && n.status === status);
}

/**
 * Whether the task's agent works in column node `n`'s column, so that its `done` waits for that work: In progress
 * (its agent's work), Ready for merge (its merge), and any other column with a prompt (which the agent is sent). In
 * the other columns `done` follows at once. Needs attention, where the agent waits for the user, has no prompt.
 */
export function agent_works(n: Node, g: Graph): boolean {
  return n.kind === "column" && (n.status === "in_progress" || n.status === "ready_for_merge" || n.prompt.trim() !== "" || wire(g, n.id, "prompt") != null);
}

/**
 * What the board does once column node `id`'s work is done, as its prompt tells the agent: the steps after its `done`
 * up to the columns they move the task to, when they go well (both ways of a check, but not after a failure).
 */
export function after_done(g: Graph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const edges = flow_edges(g);
  let next = edges.filter((e) => e.from === id && e.port === "done").map((e) => e.to);
  while (next.length) {
    const later: string[] = [];
    for (const to of next) {
      if (seen.has(to)) continue;
      seen.add(to);
      const n = graph_node(g, to);
      if (!n) continue;
      if (n.kind === "column") {
        out.push(`moves the task to ${status_label(n.status)}`);
        continue;
      }
      if (n.kind === "open_pr") out.push("pushes your branch and opens its pull request (so don't open one yourself)");
      else if (n.kind === "agent") out.push(n.output === "verdict" ? `has "${n.name}" review your work` : `has "${n.name}" read your work`);
      else if (n.kind === "send_to_task") out.push("sends you what it found to fix");
      // What happens when it goes well: not after a failure, or a send out of rounds.
      later.push(...edges.filter((e) => e.from === to && e.port !== "failed" && e.port !== "exhausted").map((e) => e.to));
    }
    next = later;
  }
  return out.filter((x, i) => out.indexOf(x) === i);
}

/** Whether the board opens the pull request once column node `id`'s work is done (before it moves the task on). */
export function opens_pr(g: Graph, id: string): boolean {
  const seen = new Set<string>([id]);
  const edges = flow_edges(g);
  const stack = edges.filter((e) => e.from === id && e.port === "done").map((e) => e.to);
  while (stack.length) {
    const to = stack.pop()!;
    if (seen.has(to)) continue;
    seen.add(to);
    const n = graph_node(g, to);
    if (!n || n.kind === "column") continue;
    if (n.kind === "open_pr") return true;
    stack.push(...edges.filter((e) => e.from === to).map((e) => e.to));
  }
  return false;
}

/** A column's name on the board. */
export function status_label(status: string): string {
  const names: Record<string, string> = {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    needs_attention: "Needs attention",
    in_review: "In review",
    ready_for_merge: "Ready for merge",
    done: "Done",
  };
  return names[status] ?? status;
}

/** The agent steps with a path to node `id`, in the graph's order: whose output it's given. */
export function upstream(g: Graph, id: string): Node[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const to = stack.pop()!;
    for (const e of flow_edges(g)) {
      if (e.to !== to || seen.has(e.from)) continue;
      seen.add(e.from);
      stack.push(e.from);
    }
  }
  return g.nodes.filter((n) => n.kind === "agent" && n.id !== id && seen.has(n.id));
}

export interface Workflow {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  graph: Graph;
  created_at: string;
  updated_at: string;
}

function Workflow_from_row(r: any): Workflow {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    enabled: !!r.enabled,
    graph: Graph_from_json(JSON.parse(r.graph)),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** One node's part of a run. */
export interface NodeRun {
  /** pending, running, done, skipped, failed or stopped */
  state: string;
  /** The port it ended on. */
  port?: string;
  /** An agent step's thread. */
  thread_id?: string;
  /** Who works an agent step, e.g. "Claude · haiku". */
  label?: string;
  /** An agent step's output (its last message, or its verdict's summary), or why a node failed. */
  text?: string;
  /** A verdict step's verdict (pass or issues), set by `submit_review` while it runs. */
  verdict?: string;
  issues?: string[];
  /** The thread's last run before this step's (empty if it had none), so an earlier run's late end doesn't end it. */
  after_run?: string;
  /** It's where the run started (a column, or the start for a run by hand). */
  start?: boolean;
  started_at?: string;
  finished_at?: string;
}

export function settled(r: NodeRun): boolean {
  return r.state !== "pending" && r.state !== "running";
}

/** A workflow's run on a task. */
export interface Run {
  id: string;
  workflow_id: string;
  task_id: string;
  /**
   * What started it: `status` (the task entering a column), `finished` (its agent's work in a column being done, which
   * a run waiting for it becomes, see engine.on_finished), `merged`, or `manual`.
   */
  source: string;
  /** running, done or stopped */
  state: string;
  /** The task's commit when it started. */
  head: string | null;
  /**
   * The task's latest run when it started, which tells whether its agent worked since. Serde skips it: a hidden
   * property (see db.hidden).
   */
  task_run: string | null;
  /** The workflow's graph as it was when it started. */
  graph: Graph;
  nodes: Record<string, NodeRun>;
  /** Sends in a row per send node, carried from one run to the next. */
  rounds: Record<string, number>;
  detail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export function Run_from_row(r: any): Run {
  const run: any = {
    id: r.id,
    workflow_id: r.workflow_id,
    task_id: r.task_id,
    source: r.source,
    state: r.state,
    head: r.head ?? null,
    graph: Graph_from_json(JSON.parse(r.graph)),
    nodes: JSON.parse(r.nodes),
    rounds: JSON.parse(r.rounds),
    detail: r.detail ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at ?? null,
  };
  db.hidden(run, "task_run", r.task_run ?? null);
  return run;
}

/** Node `id`'s part of the run (pending if it has none yet). */
export function run_node(run: Run, id: string): NodeRun {
  return run.nodes[id] ? { ...run.nodes[id] } : { state: "pending" };
}

/** Node `id`'s part of the run, to change in place (Rust's `nodes.entry(id).or_default()`). */
export function node_entry(run: Run, id: string): NodeRun {
  return (run.nodes[id] ??= { state: "" });
}

/** The keys of a map in order, as serde writes a BTreeMap. */
function sorted<T>(m: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

// ---------- the database ----------

export function get(c: Conn, id: string): Workflow | null {
  const r = db.one(c, "SELECT * FROM workflows WHERE id=?1", id);
  return r ? Workflow_from_row(r) : null;
}

export function list(c: Conn, project_id: string): Workflow[] {
  return db.all(c, "SELECT * FROM workflows WHERE project_id=?1 ORDER BY created_at, id", project_id).map(Workflow_from_row);
}

export function get_run(c: Conn, id: string): Run | null {
  const r = db.one(c, "SELECT * FROM workflow_runs WHERE id=?1", id);
  return r ? Run_from_row(r) : null;
}

/**
 * The latest run of each workflow on the task, newest first. With `steps`, also the latest earlier run in which each
 * of its agent steps ran, where the latest skipped it (a run from one column, say, when the step comes after another),
 * so the task's tabs show each step's last output.
 */
export function latest_runs(c: Conn, task_id: string, steps = false): Run[] {
  const all = db.all(c, "SELECT * FROM workflow_runs WHERE task_id=?1 ORDER BY rowid DESC", task_id).map(Run_from_row);
  const out: Run[] = [];
  const ran = (r: Run, id: string) => {
    const st = r.nodes[id]?.state;
    return st != null && st !== "pending" && st !== "skipped";
  };
  for (const latest of all) {
    if (out.some((r) => r.workflow_id === latest.workflow_id)) continue;
    out.push(latest);
    if (!steps) continue;
    for (const n of latest.graph.nodes) {
      if (n.kind !== "agent" || ran(latest, n.id)) continue;
      const earlier = all.find((r) => r.workflow_id === latest.workflow_id && r.id !== latest.id && ran(r, n.id));
      if (earlier && !out.includes(earlier)) out.push(earlier);
    }
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : all.indexOf(a) - all.indexOf(b)));
}

/** The workflow's latest run on the task. */
export function latest_run(c: Conn, workflow_id: string, task_id: string): Run | null {
  const r = db.one(c, "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 ORDER BY rowid DESC LIMIT 1", workflow_id, task_id);
  return r ? Run_from_row(r) : null;
}

/** Runs in progress, on one task or every one. */
export function running(c: Conn, task_id: string | null): Run[] {
  return db.all(c, "SELECT * FROM workflow_runs WHERE state='running' AND (?1 IS NULL OR task_id=?1) ORDER BY rowid", task_id).map(Run_from_row);
}

export function insert_run(c: Conn, r: Run): void {
  db.run(
    c,
    `INSERT INTO workflow_runs (id,workflow_id,task_id,source,state,head,task_run,graph,nodes,rounds,detail,created_at,updated_at,finished_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    r.id,
    r.workflow_id,
    r.task_id,
    r.source,
    r.state,
    r.head,
    r.task_run,
    JSON.stringify(r.graph),
    JSON.stringify(sorted(r.nodes)),
    JSON.stringify(sorted(r.rounds)),
    r.detail,
    r.created_at,
    r.updated_at,
    r.finished_at,
  );
  // Each workflow keeps its latest runs on each task.
  db.run(
    c,
    `DELETE FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND state!='running' AND rowid NOT IN
       (SELECT rowid FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 ORDER BY rowid DESC LIMIT 20)`,
    r.workflow_id,
    r.task_id,
  );
}

export function save_run(c: Conn, r: Run): void {
  db.run(
    c,
    "UPDATE workflow_runs SET state=?2, nodes=?3, rounds=?4, detail=?5, updated_at=?6, finished_at=?7, source=?8, task_run=?9 WHERE id=?1",
    r.id,
    r.state,
    JSON.stringify(sorted(r.nodes)),
    JSON.stringify(sorted(r.rounds)),
    r.detail,
    r.updated_at,
    r.finished_at,
    r.source,
    r.task_run,
  );
}

// ---------- checking what's given ----------

const bad = (m: string) => ApiError.bad(m);
const chars = (s: string) => [...s].length;
const bytes = (s: string) => Buffer.byteLength(s);

export function check_name(v: any): string {
  const n = typeof v === "string" ? v.trim() : null;
  if (n && chars(n) <= 100) return n;
  throw bad("name must be 1 to 100 characters");
}

function trimmed(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Sets an optional field to `x`, or takes it off. */
function set_opt(o: any, k: string, x: string | undefined) {
  if (x === undefined) delete o[k];
  else o[k] = x;
}

/** The graph as given, checked against project `p`, and tidied (blank settings dropped). */
export function check_graph(c: Conn, p: Project, v: any): Graph {
  let g: Graph;
  try {
    g = Graph_from_json(v);
  } catch (e) {
    throw bad(`graph: ${err_str(e)}`);
  }
  if (g.nodes.length > MAX_NODES) throw bad(`a workflow has at most ${MAX_NODES} nodes`);
  const ids = new Set<string>();
  let triggers = 0;
  let agents = 0;
  const columns = new Set<string>();
  for (const n of g.nodes) {
    n.id = n.id.trim();
    if (!n.id || n.id.length > 40 || !/^[A-Za-z0-9_-]+$/.test(n.id)) throw bad(`node id ${JSON.stringify(n.id)} must be 1 to 40 letters, digits, - or _`);
    if (ids.has(n.id)) throw bad(`two nodes have the id ${n.id}`);
    ids.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = 0;
      n.y = 0;
    }
    const id = n.id;
    switch (n.kind) {
      case "trigger":
        triggers += 1;
        break;
      case "column": {
        n.status = n.status.trim();
        if (!db.STATUSES.includes(n.status)) throw bad(`column ${id} needs a column: one of ${db.STATUSES.join(", ")}`);
        if (n.status === "done" && n.prompt.trim()) throw bad(`column ${id} can't have a prompt: the agent has no work in Done`);
        if (columns.has(n.status)) throw bad(`two nodes are the column ${status_label(n.status)}: a workflow has one node for each column`);
        columns.add(n.status);
        if (bytes(n.prompt) > MAX_TEXT) throw bad(`column ${id}'s prompt is longer than ${MAX_TEXT} bytes`);
        if (n.status === "needs_attention" && n.prompt.trim()) {
          throw bad(`column ${id} can't have a prompt: in Needs attention the agent waits for the user`);
        }
        if (!agent_works(n, g)) delete n.done_when;
        else if (n.status === "ready_for_merge" && n.done_when) throw bad(`column ${id}'s work is done when the task is merged, not when the agent says so`);
        // Only edges into In progress give the agent work (see engine's `enter_column`).
        if (n.status !== "in_progress") delete n.max_rounds;
        else if (n.max_rounds !== undefined && (n.max_rounds < 1 || n.max_rounds > MAX_ROUNDS))
          throw bad(`column ${id} can give the agent its work 1 to ${MAX_ROUNDS} times in a row`);
        break;
      }
      case "condition": {
        set_opt(n, "value", trimmed(n.value));
        if (n.check === "task_type") {
          const t = n.value;
          if (!(t === "code" || (t !== undefined && db.TASK_TYPES.includes(t))))
            throw bad(`condition ${id} needs a task type: code or ${db.TASK_TYPES.join(", ")}`);
        } else if (n.check === "label") {
          if (!(n.value !== undefined && db.LABELS.includes(n.value))) throw bad(`condition ${id} needs a label: ${db.LABELS.join(", ")}`);
        } else delete n.value;
        break;
      }
      case "agent": {
        agents += 1;
        n.name = n.name.trim();
        if (!n.name || chars(n.name) > 60) throw bad(`agent step ${id} needs a name of 1 to 60 characters`);
        if (bytes(n.prompt) > MAX_TEXT) throw bad(`agent step ${id}'s prompt is longer than ${MAX_TEXT} bytes`);
        set_opt(n, "claude_config_id", trimmed(n.claude_config_id));
        const cid = n.claude_config_id;
        if (cid !== undefined && !db.available_configs(c, p.profile_id, p).some((cfg) => cfg.id === cid)) {
          throw bad(`agent step ${id}'s claude_config_id ${cid} isn't one of the project's (or profile's) agent configs`);
        }
        set_opt(n, "model", trimmed(n.model));
        // Given to the agent's command line as it is (see agent/runner/launch.ts): a name, not an option.
        if (n.model !== undefined && (chars(n.model) > 100 || n.model.startsWith("-") || /[\s\p{Cc}]/u.test(n.model))) {
          throw bad(`agent step ${id}'s model must be a model's name of up to 100 characters, without spaces`);
        }
        set_opt(n, "effort", trimmed(n.effort));
        if (n.effort !== undefined && !db.THREAD_EFFORTS.includes(n.effort))
          throw bad(`agent step ${id}'s effort must be one of ${db.THREAD_EFFORTS.join(", ")}`);
        const skills = (n.skills ?? []).filter((s) => s.trim()).map((s) => s.trim().replace(/^[/$]+/, ""));
        if (skills.length > 10) throw bad(`agent step ${id} has more than 10 skills`);
        if (skills.length) n.skills = skills;
        else delete n.skills;
        set_opt(n, "tab", trimmed(n.tab));
        if (n.tab !== undefined && chars(n.tab) > 30) throw bad(`agent step ${id}'s tab name is longer than 30 characters`);
        break;
      }
      case "send_to_task": {
        if (bytes(n.message) > MAX_TEXT) throw bad(`send step ${id}'s message is longer than ${MAX_TEXT} bytes`);
        if (n.max_rounds > MAX_ROUNDS) throw bad(`send step ${id} can have at most ${MAX_ROUNDS} rounds`);
        break;
      }
      case "set_status": {
        n.status = n.status.trim();
        if (!db.STATUSES.includes(n.status) || n.status === "done") {
          throw bad(`move step ${id} needs a column: one of ${db.STATUSES.filter((s) => s !== "done").join(", ")}`);
        }
        break;
      }
      case "open_pr": {
        n.title = n.title.trim();
        if (bytes(n.title) > 1000) throw bad(`pull request step ${id}'s title is longer than 1000 bytes`);
        if (bytes(n.body) > MAX_TEXT) throw bad(`pull request step ${id}'s body is longer than ${MAX_TEXT} bytes`);
        break;
      }
      case "text":
        if (bytes(n.text) > MAX_TEXT) throw bad(`text ${id} is longer than ${MAX_TEXT} bytes`);
        break;
      case "task":
      case "project_prompt":
        break;
      case "compose":
        if (bytes(n.template) > MAX_TEXT) throw bad(`compose ${id}'s template is longer than ${MAX_TEXT} bytes`);
        if (template_inputs(n.template).length > 20) throw bad(`compose ${id} has more than 20 inputs`);
        break;
      case "join":
        if (n.count < 1 || n.count > MAX_JOIN) throw bad(`join ${id} takes 1 to ${MAX_JOIN} inputs`);
        if (chars(n.separator) > 100) throw bad(`join ${id}'s separator is longer than 100 characters`);
        break;
      case "switch": {
        set_opt(n, "value", trimmed(n.value));
        if (!SWITCH_CHECKS.includes(n.check)) throw bad(`switch ${id} checks ${SWITCH_CHECKS.join(", ")}`);
        if (n.check === "task_type") {
          const t = n.value;
          if (!(t === "code" || (t !== undefined && db.TASK_TYPES.includes(t))))
            throw bad(`switch ${id} needs a task type: code or ${db.TASK_TYPES.join(", ")}`);
        } else if (n.check === "label") {
          if (!(n.value !== undefined && db.LABELS.includes(n.value))) throw bad(`switch ${id} needs a label: ${db.LABELS.join(", ")}`);
        } else delete n.value;
        break;
      }
    }
  }
  if (triggers > 1) throw bad("a workflow has one start for runs by hand at most");
  if (!triggers && !columns.size) throw bad("a workflow needs a column node (or a start, to run it only by hand)");
  if (agents > MAX_AGENTS) throw bad(`a workflow has at most ${MAX_AGENTS} agent steps`);
  const seen = new Set<string>();
  for (const e of g.edges) {
    const from = graph_node(g, e.from);
    if (!from) throw bad(`an edge comes from node ${e.from}, which isn't in the graph`);
    const to = graph_node(g, e.to);
    if (!to) throw bad(`an edge goes to node ${e.to}, which isn't in the graph`);
    if (e.input != null) {
      // A data wire: from a value to an input, one wire to each.
      if (!data_outputs(from).includes(e.port)) throw bad(`node ${e.from} gives no value ${e.port} (it gives ${data_outputs(from).join(", ") || "none"})`);
      if (!data_inputs(to).includes(e.input)) throw bad(`node ${e.to} has no input ${e.input} (it has ${data_inputs(to).join(", ") || "none"})`);
      const key = JSON.stringify([e.to, e.input]);
      if (seen.has(key)) throw bad(`node ${e.to}'s input ${e.input} has two wires into it`);
      seen.add(key);
      continue;
    }
    if (!ports(from).includes(e.port)) throw bad(`node ${e.from} has no port ${e.port} (it has ${ports(from).join(", ") || "none: it gives values"})`);
    if (to.kind === "trigger") throw bad("no edge can go into the start");
    if (is_data(to)) throw bad(`node ${e.to} gives values, so no run goes into it: wire a value into one of its inputs instead`);
    if (to.kind === "column" && to.status === "done") throw bad("no edge can go into Done: a task is done once it's merged (from Ready for merge)");
    const key = JSON.stringify([e.from, e.port, e.to]);
    if (seen.has(key)) throw bad(`the edge from ${e.from}.${e.port} to ${e.to} is there twice`);
    seen.add(key);
  }
  const c_ = cycle(g);
  if (c_ !== null) {
    throw bad(
      `the graph goes round in a loop through ${c_}: a run goes forward from where it starts (go round again through a column, or by sending to the task's agent)`,
    );
  }
  const d = data_cycle(g);
  if (d !== null) throw bad(`values go round in a loop through ${d}: a data node can't take its own value`);
  return g;
}

/**
 * A data node whose value depends on itself through data wires, if any. A step's outputs come from its run (or an
 * earlier one), so a wire from a step back into one before it is no loop.
 */
export function data_cycle(g: Graph): string | null {
  const data = new Set(g.nodes.filter(is_data).map((n) => n.id));
  const wires = g.edges.filter((e) => e.input != null && data.has(e.from) && data.has(e.to));
  const state = new Map<string, number>();
  const visit = (id: string): string | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return id;
    state.set(id, 1);
    for (const e of wires)
      if (e.from === id) {
        const c = visit(e.to);
        if (c != null) return c;
      }
    state.set(id, 2);
    return null;
  };
  for (const id of [...data].sort()) {
    const c = visit(id);
    if (c != null) return c;
  }
  return null;
}

/**
 * A node on a cycle, if the graph has one. A path into a column ends there (the next run starts from it), so a cycle
 * through a column is no loop.
 */
export function cycle(g: Graph): string | null {
  const into_column = (e: Edge) => graph_node(g, e.to)?.kind === "column";
  const edges = flow_edges(g).filter((e) => !into_column(e));
  const indegree = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  let done = 0;
  while (ready.length) {
    const n = ready.pop()!;
    done += 1;
    for (const e of edges.filter((e) => e.from === n)) {
      const d = indegree.get(e.to)! - 1;
      indegree.set(e.to, d);
      if (d === 0) ready.push(e.to);
    }
  }
  if (done >= g.nodes.length) return null;
  const left = [...indegree]
    .filter(([, d]) => d > 0)
    .map(([n]) => n)
    .sort();
  return left[0] ?? "";
}

// ---------- changing workflows ----------

/**
 * Checks that no other workflow of the project that's on (but `except`) has a node for a column where `graph` waits for
 * the agent's work (see `agent_works`): the agent is sent one column's prompt, and its work goes on from one node.
 */
function check_columns(c: Conn, project_id: string, except: string | null, graph: Graph) {
  for (const w of list(c, project_id)) {
    if (w.id === except || !w.enabled) continue;
    for (const n of graph.nodes) {
      if (n.kind !== "column") continue;
      const other = column_node(w.graph, n.status);
      if (other && (agent_works(n, graph) || agent_works(other, w.graph))) {
        throw ApiError.conflict(
          `the workflow "${w.name}" has the column ${status_label(n.status)} already, where the task's agent works: a column with the agent's work belongs to one workflow that's on`,
        );
      }
    }
  }
}

function changed(s: Shared, project_id: string, id: string) {
  s.emit({ type: "workflows_changed", project_id, workflow_id: id });
}

function check_enabled(v: any, def: boolean): boolean {
  if (v == null) return def;
  if (typeof v !== "boolean") throw bad("enabled must be true or false");
  return v;
}

/** A new workflow in project `project_id`: `{name, graph, enabled?}`. */
export function create(s: Shared, project_id: string, b: Record<string, any>): Workflow {
  const p = db.get_project(s.db(), project_id);
  if (!p) throw ApiError.not_found("project");
  const name = check_name(b.name ?? null);
  const graph = check_graph(s.db(), p, b.graph ?? null);
  const enabled = check_enabled(b.enabled, true);
  if (enabled) check_columns(s.db(), p.id, null, graph);
  const id = new_id();
  const at = now();
  db.run(
    s.db(),
    "INSERT INTO workflows (id,project_id,name,enabled,graph,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
    id,
    p.id,
    name,
    enabled,
    JSON.stringify(graph),
    at,
  );
  changed(s, p.id, id);
  return get(s.db(), id)!;
}

/** Changes a workflow: any of `name`, `graph` and `enabled`. */
export function update(s: Shared, id: string, b: Record<string, any>): Workflow {
  const w = get(s.db(), id);
  if (!w) throw ApiError.not_found("workflow");
  const p = db.get_project(s.db(), w.project_id);
  if (!p) throw ApiError.not_found("project");
  const name = b.name == null ? w.name : check_name(b.name);
  const graph = b.graph == null ? w.graph : check_graph(s.db(), p, b.graph);
  const enabled = check_enabled(b.enabled, w.enabled);
  if (enabled && (b.graph != null || !w.enabled)) check_columns(s.db(), p.id, id, graph);
  db.run(s.db(), "UPDATE workflows SET name=?2, graph=?3, enabled=?4, updated_at=?5 WHERE id=?1", id, name, JSON.stringify(graph), enabled, now());
  changed(s, w.project_id, id);
  // Turned off, it no longer waits for its columns' work.
  if (!enabled && w.enabled) engine.stop_waiting(s, id, "Stopped because the workflow was turned off.");
  const out = get(s.db(), id);
  if (!out) throw ApiError.not_found("workflow");
  return out;
}

/** Deletes a workflow, stopping its runs in progress. Its threads stay with their tasks. */
export function delete_(s: Shared, id: string): Workflow {
  const w = get(s.db(), id);
  if (!w) throw ApiError.not_found("workflow");
  for (const r of running(s.db(), null).filter((r) => r.workflow_id === id)) engine.stop_run(s, r.id, "Stopped because the workflow was deleted.");
  const tasks: string[] = db.all(s.db(), "SELECT DISTINCT task_id FROM workflow_runs WHERE workflow_id=?1", id).map((r: any) => r.task_id);
  db.run(s.db(), "DELETE FROM workflows WHERE id=?1", id);
  permissions.expire_for_workflow(s, id);
  changed(s, w.project_id, id);
  for (const t of tasks) engine.runs_changed(s, t);
  return w;
}
export { delete_ as delete };
