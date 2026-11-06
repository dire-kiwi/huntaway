// Port of server/src/integrations/workflows.rs (HA-173's branch, ported by HA-189).
/**
 * Workflows: a project's automations that act on its tasks, as graphs of nodes (HA-173, API 107).
 *
 * A workflow's **trigger** node starts a run on a task: when the task enters a column (such as *In review*, which is
 * where its agent's finished work goes), when the task's agent finishes its work (`on: finished`, HA-276: the task then
 * stays in *In progress* rather than going to *In review*, and the workflow moves it on, or `release` does once it ends),
 * or only when it's run by hand
 * (`POST /workflows/{id}/run`, `run_workflow`).
 * From there the run follows the graph's edges, out of the **port** each node ends on:
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
 *   with the gh tools, as the task's GitHub account): `opened`, `exists` (the task has one already) or `failed`. Its
 *   title and body are templates, so an agent step before it can write them;
 * - **send to the task's agent** sends a message (by default the issues the run's agents found) to the task's
 *   agent: at most `max_rounds` runs in a row (`sent`), then `exhausted`, which with nothing after it leaves the
 *   task in *Needs attention*. Sending ends the run, as the agent's work changes under it;
 * - **move the task** to another column (`out`).
 *
 * A node runs once every node with an edge into it has finished, when one of those edges was taken (`join: any`,
 * the default) or all of them (`join: all`); otherwise it's skipped, and so are the nodes only it leads to. Nodes
 * with several outputs side by side run at once, so two agent steps after the trigger review together.
 *
 * A run keeps the graph as it was when it started, so changing a workflow doesn't change runs in progress. A run in
 * progress is stopped when the task's agent starts working again (its work is changing) or the task is stopped.
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
export const MAX_NODES = 40;
export const MAX_AGENTS = 8;
/** Most rounds a send can be given. */
export const MAX_ROUNDS = 20;
const MAX_TEXT = 20_000;

// ---------- what a workflow is ----------

export type Join = "any" | "all";
export type TriggerOn = "status" | "finished" | "manual";
/**
 * `changed`: the workflow hasn't finished a run on the task, or its commit or its agent's work changed since.
 * `has_commits`: its branch has commits of its own. `has_pr`: it has a pull request. `task_type`: it's of type `value`
 * (`code` for a code task). `label`: it has label `value`.
 */
export type Check = "changed" | "has_commits" | "has_pr" | "task_type" | "label";
/** `text`: its last message. `verdict`: `pass` or `issues`, reported with `submit_review`. */
export type Output = "text" | "verdict";

const TRIGGER_ONS: TriggerOn[] = ["status", "finished", "manual"];
const CHECKS: Check[] = ["changed", "has_commits", "has_pr", "task_type", "label"];
const OUTPUTS: Output[] = ["text", "verdict"];
const KINDS = ["trigger", "condition", "agent", "send_to_task", "set_status", "open_pr"];

export type NodeKind =
  /**
   * What starts a run: the task entering `status` (`on: status`), its agent finishing its work (`on: finished`), or only
   * a run by hand (`on: manual`).
   */
  | { kind: "trigger"; on: TriggerOn; status?: string }
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
  /** Moves the task to another column. */
  | { kind: "set_status"; status: string }
  /**
   * Opens a pull request for the task's branch: `title` and `body` are templates (empty: the task's key and title, and
   * its agent's last message), and `draft` opens it as a draft.
   */
  | { kind: "open_pr"; title: string; body: string; draft?: boolean };

/** A node: its id, its kind's fields (flattened), `join` (left out when `any`) and where the editor draws it. */
export type Node = { id: string } & NodeKind & { join?: Join; x: number; y: number };

/** An edge from `from`'s `port` to `to`. */
export interface Edge {
  from: string;
  port: string;
  to: string;
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
    case "trigger":
      n.on = de_enum(v, "on", TRIGGER_ONS);
      put(n, "status", de_opt_str(v, "status"));
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
      n.status = de_str(v, "status");
      break;
    case "open_pr":
      n.title = de_def_str(v, "title");
      n.body = de_def_str(v, "body");
      if (de_bool(v, "draft")) n.draft = true;
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
  return { from: de_str(v, "from"), port: v.port === undefined ? "out" : de_str(v, "port"), to: de_str(v, "to") };
}

export function Graph_from_json(v: any): Graph {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("invalid type: expected struct Graph");
  const seq = (k: string): any[] => (v[k] === undefined ? [] : Array.isArray(v[k]) ? v[k] : fail(`invalid type for \`${k}\`: expected a sequence`));
  return { nodes: seq("nodes").map(Node_from_json), edges: seq("edges").map(Edge_from_json) };
}

/** The ports a node of this kind can end on. */
export function ports(n: NodeKind): string[] {
  switch (n.kind) {
    case "trigger":
    case "set_status":
      return ["out"];
    case "condition":
      return ["yes", "no"];
    case "agent":
      return n.output === "verdict" ? ["pass", "issues", "failed"] : ["done", "failed"];
    case "send_to_task":
      return ["sent", "exhausted"];
    case "open_pr":
      return ["opened", "exists", "failed"];
  }
}

export function graph_node(g: Graph, id: string): Node | undefined {
  return g.nodes.find((n) => n.id === id);
}

export function trigger(g: Graph): Node | undefined {
  return g.nodes.find((n) => n.kind === "trigger");
}

/** The column whose tasks entering it start a run, if its trigger is one. */
export function trigger_status(g: Graph): string | null {
  const t = trigger(g);
  return t?.kind === "trigger" && t.on === "status" ? (t.status ?? null) : null;
}

/** Whether its trigger is the task's agent finishing its work. */
export function on_finish(g: Graph): boolean {
  const t = trigger(g);
  return t?.kind === "trigger" && t.on === "finished";
}

/** The agent steps with a path to node `id`, in the graph's order: whose output it's given. */
export function upstream(g: Graph, id: string): Node[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const to = stack.pop()!;
    for (const e of g.edges) {
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
  /** `status` (its trigger) or `manual`. */
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

/** The latest run of each workflow on the task, newest first. */
export function latest_runs(c: Conn, task_id: string): Run[] {
  return db
    .all(
      c,
      `SELECT * FROM workflow_runs r WHERE task_id=?1 AND rowid = (SELECT MAX(rowid) FROM workflow_runs WHERE task_id=?1 AND workflow_id=r.workflow_id)
       ORDER BY created_at DESC, rowid DESC`,
      task_id,
    )
    .map(Run_from_row);
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
    "UPDATE workflow_runs SET state=?2, nodes=?3, rounds=?4, detail=?5, updated_at=?6, finished_at=?7 WHERE id=?1",
    r.id,
    r.state,
    JSON.stringify(sorted(r.nodes)),
    JSON.stringify(sorted(r.rounds)),
    r.detail,
    r.updated_at,
    r.finished_at,
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
      case "trigger": {
        triggers += 1;
        set_opt(n, "status", trimmed(n.status));
        if (n.on !== "status") delete n.status;
        else if (!n.status || !db.STATUSES.includes(n.status)) throw bad(`trigger ${id} needs the column (status) whose tasks entering it start a run`);
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
    }
  }
  if (triggers !== 1) throw bad("a workflow needs exactly one trigger node");
  if (agents > MAX_AGENTS) throw bad(`a workflow has at most ${MAX_AGENTS} agent steps`);
  const seen = new Set<string>();
  for (const e of g.edges) {
    const from = graph_node(g, e.from);
    if (!from) throw bad(`an edge comes from node ${e.from}, which isn't in the graph`);
    const to = graph_node(g, e.to);
    if (!to) throw bad(`an edge goes to node ${e.to}, which isn't in the graph`);
    if (!ports(from).includes(e.port)) throw bad(`node ${e.from} has no port ${e.port} (it has ${ports(from).join(", ")})`);
    if (to.kind === "trigger") throw bad("no edge can go into the trigger");
    const key = JSON.stringify([e.from, e.port, e.to]);
    if (seen.has(key)) throw bad(`the edge from ${e.from}.${e.port} to ${e.to} is there twice`);
    seen.add(key);
  }
  const c_ = cycle(g);
  if (c_ !== null) {
    throw bad(`the graph goes round in a loop through ${c_}: a workflow runs from its trigger forward (send to the task's agent to go round again)`);
  }
  return g;
}

/** A node on a cycle, if the graph has one. */
export function cycle(g: Graph): string | null {
  const indegree = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  let done = 0;
  while (ready.length) {
    const n = ready.pop()!;
    done += 1;
    for (const e of g.edges.filter((e) => e.from === n)) {
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
  db.run(s.db(), "UPDATE workflows SET name=?2, graph=?3, enabled=?4, updated_at=?5 WHERE id=?1", id, name, JSON.stringify(graph), enabled, now());
  changed(s, w.project_id, id);
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
