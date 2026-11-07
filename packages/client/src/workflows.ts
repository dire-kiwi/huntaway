import { enc, type Http } from "./http";
import type { Status } from "./tasks";

/**
 * What starts a workflow's run on a task: a run by hand, or before API 128 the task entering a column (from API 128,
 * column nodes, which the host reads these as).
 */
export type WorkflowTrigger = { kind: "trigger"; on: "status"; status: Status } | { kind: "trigger"; on: "manual"; status?: null };

/**
 * Column nodes (a task's way across the board, column by column, with the prompt its agent is sent in each), open_pr
 * steps and agent steps' input_only (HA-276). Hosts before it have triggers on a column and set_status moves instead.
 */
export const COLUMN_WORKFLOWS_API = 128;
/** How many times in a row lines back into In progress give the agent its work, for a column node without `max_rounds`. */
export const COLUMN_ROUNDS = 3;

/** When a column node's work is done: when the agent's run ends, or when it says so with `finish_work`. */
export type WorkflowDoneWhen = "run_end" | "finish";

export const WORKFLOW_CHECKS = ["changed", "has_commits", "has_pr", "task_type", "label"] as const;
export type WorkflowCheck = (typeof WORKFLOW_CHECKS)[number];

/** A workflow node's settings, by its kind. */
export type WorkflowNodeKind =
  | WorkflowTrigger
  /**
   * A column (API 128): a task entering it starts a run here, and its agent is sent `prompt` (in In progress, its start
   * prompt; in Ready for merge, how to merge). `done` once that work is (see `workflowWaits`). An edge into it moves
   * the task there.
   */
  | { kind: "column"; status: Status; prompt: string; done_when?: WorkflowDoneWhen; max_rounds?: number }
  | { kind: "condition"; check: WorkflowCheck; value?: string | null }
  | {
      kind: "agent";
      name: string;
      prompt: string;
      /** `text`: its last message is its output; `verdict`: it reports pass or issues with submit_review. */
      output: "text" | "verdict";
      claude_config_id?: string | null;
      model?: string | null;
      effort?: string | null;
      skills?: string[];
      /** The project's MCP servers its thread doesn't get (API 128). */
      disabled_mcp_servers?: string[];
      /** The task panel tab its output shows in. */
      tab?: string | null;
      /** It's given only the output of the steps before it and its prompt, not where the task's work is (API 128). */
      input_only?: boolean;
    }
  | { kind: "send_to_task"; message: string; max_rounds: number }
  /** Moves the task, on hosts before API 128. */
  | { kind: "set_status"; status: Status }
  /** Pushes the task's branch and opens its pull request: title and body are templates (empty: the defaults). API 128. */
  | { kind: "open_pr"; title: string; body: string; draft?: boolean }
  // Data nodes (API 128): values for other nodes' inputs, through data wires (see `workflowDataInputs`). No run goes into them.
  | { kind: "text"; text: string }
  | { kind: "task" }
  | { kind: "project_prompt"; which: "start" | "review" | "merge" }
  /** A template whose `{{name}}`s without a dot are inputs. */
  | { kind: "compose"; template: string }
  | { kind: "join"; separator: string; count: number }
  | { kind: "switch"; check: WorkflowCheck; value?: string | null };

export type WorkflowNodeKindName = WorkflowNodeKind["kind"];

/** A node; a data node's `label` is the name the editor shows it by (API 128; without one, its kind's). */
export type WorkflowNode = WorkflowNodeKind & { id: string; x: number; y: number; join?: "any" | "all"; label?: string };

/** The way a run goes from `from`'s `port` to `to`; with `input`, a data wire from `from`'s value `port` to `to`'s input. */
export interface WorkflowEdge {
  from: string;
  port: string;
  to: string;
  input?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** A project's workflow (API 107). */
export interface Workflow {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  graph: WorkflowGraph;
  created_at: string;
  updated_at: string;
}

export type WorkflowNodeState = "pending" | "running" | "done" | "skipped" | "failed" | "stopped";

/** One node's part of a run. */
export interface WorkflowNodeRun {
  state: WorkflowNodeState;
  port?: string | null;
  thread_id?: string | null;
  label?: string | null;
  text?: string | null;
  verdict?: "pass" | "issues" | null;
  issues?: string[];
  started_at?: string | null;
  finished_at?: string | null;
  /** Where the run started: a column (which, running, waits for the agent's work there), or the start. */
  start?: boolean;
}

/** A workflow's run on a task, with the graph it started with. */
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  /** Null once the workflow is deleted. */
  workflow_name: string | null;
  task_id: string;
  source: "status" | "finished" | "merged" | "manual";
  state: "running" | "done" | "stopped";
  head: string | null;
  graph: WorkflowGraph;
  nodes: Record<string, WorkflowNodeRun>;
  rounds: Record<string, number>;
  detail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export const WORKFLOW_DATA_KINDS = ["text", "task", "project_prompt", "compose", "join", "switch"] as const;

/** Whether it's a data node, which gives values and no run goes into. */
export const isDataNode = (n: WorkflowNodeKind) => (WORKFLOW_DATA_KINDS as readonly string[]).includes(n.kind);

/** The `{{name}}`s of a compose template that are its inputs: those without a dot. */
export function templateInputs(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The inputs a node takes values on, which a data wire replaces its own text in. */
export function workflowDataInputs(n: WorkflowNodeKind): string[] {
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
      return templateInputs(n.template);
    case "join":
      return Array.from({ length: Math.min(Math.max(n.count, 1), 8) }, (_, i) => `in${i + 1}`);
    case "switch":
      return ["yes", "no"];
    default:
      return [];
  }
}

/** The values a node gives other nodes' inputs. */
export function workflowDataOutputs(n: WorkflowNodeKind): string[] {
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

/** The data wire into node `id`'s input `input`, if any. */
export const workflowWire = (g: WorkflowGraph, id: string, input: string) => g.edges.find((e) => e.to === id && e.input === input);

/** The ports a node of this kind ends on, which its edges go out of. */
export function workflowPorts(n: WorkflowNodeKind): string[] {
  if (isDataNode(n)) return [];
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
      return ["exhausted"];
    case "open_pr":
      return ["opened", "exists", "failed"];
    default:
      return [];
  }
}

/**
 * Whether a column node's `done` waits for the task's agent's work there: In progress, Ready for merge (its merge),
 * and a column with a prompt. Elsewhere it follows at once.
 */
export const workflowWaits = (n: WorkflowNodeKind & { id?: string }, g?: WorkflowGraph) =>
  n.kind === "column" &&
  (n.status === "in_progress" || n.status === "ready_for_merge" || n.prompt.trim() !== "" || (!!g && !!n.id && !!workflowWire(g, n.id, "prompt")));

/** The column node a run waits at for the task's agent's work there, which it was sent the prompt of. */
export function workflowWaitingAt(r: WorkflowRun): Extract<WorkflowNode, { kind: "column" }> | null {
  if (r.state !== "running") return null;
  for (const n of r.graph.nodes) if (n.kind === "column" && r.nodes[n.id]?.start && r.nodes[n.id]?.state === "running") return n;
  return null;
}

/** The columns a workflow has nodes for, counting a host's from before API 128 (its start's column). */
export function workflowColumns(g: WorkflowGraph): Status[] {
  return g.nodes.flatMap((n) => (n.kind === "column" || (n.kind === "trigger" && n.on === "status") ? [n.status] : []));
}

export const workflowsApi = ({ on }: Http) => ({
  workflows: (h: string, projectId: string) => on(h).get<{ workflows: Workflow[] }>(`/projects/${enc(projectId)}/workflows`),
  createWorkflow: (h: string, projectId: string, b: { name: string; graph: WorkflowGraph; enabled?: boolean }) =>
    on(h).post<Workflow>(`/projects/${enc(projectId)}/workflows`, b),
  updateWorkflow: (h: string, id: string, b: { name?: string; graph?: WorkflowGraph; enabled?: boolean }) => on(h).patch<Workflow>(`/workflows/${enc(id)}`, b),
  deleteWorkflow: (h: string, id: string) => on(h).del(`/workflows/${enc(id)}`),
  /** Run it on one of its project's tasks now, on or off and whatever its trigger. */
  runWorkflow: (h: string, id: string, taskId: string) => on(h).post<WorkflowRun>(`/workflows/${enc(id)}/run`, { task_id: taskId }),
  /** The latest run of each workflow on the task, and its project's workflows. */
  taskWorkflowRuns: (h: string, taskId: string) =>
    on(h).get<{ runs: WorkflowRun[]; workflows: { id: string; name: string; enabled: boolean }[] }>(`/tasks/${enc(taskId)}/workflow-runs`),
  stopWorkflowRun: (h: string, runId: string) => on(h).post<{ stopped: boolean }>(`/workflow-runs/${enc(runId)}/stop`, {}),
});
