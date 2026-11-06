import { enc, type Http } from "./http";
import type { Status } from "./tasks";

/**
 * What starts a workflow's run on a task: the task entering a column, or only a run by hand (API 107), or its agent
 * finishing its work, which leaves the task in its column for the workflow to move on (API 123, `FINISHED_WORKFLOWS_API`).
 */
export type WorkflowTrigger =
  | { kind: "trigger"; on: "status"; status: Status }
  | { kind: "trigger"; on: "finished"; status?: null }
  | { kind: "trigger"; on: "manual"; status?: null };

/** The finished trigger, open_pr steps and agent steps' input_only. */
export const FINISHED_WORKFLOWS_API = 123;

export const WORKFLOW_CHECKS = ["changed", "has_commits", "has_pr", "task_type", "label"] as const;
export type WorkflowCheck = (typeof WORKFLOW_CHECKS)[number];

/** A workflow node's settings, by its kind. */
export type WorkflowNodeKind =
  | WorkflowTrigger
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
      /** The task panel tab its output shows in. */
      tab?: string | null;
      /** It's given only the output of the steps before it and its prompt, not where the task's work is (API 123). */
      input_only?: boolean;
    }
  | { kind: "send_to_task"; message: string; max_rounds: number }
  | { kind: "set_status"; status: Status }
  /** Pushes the task's branch and opens its pull request: title and body are templates (empty: the defaults). API 123. */
  | { kind: "open_pr"; title: string; body: string; draft?: boolean };

export type WorkflowNodeKindName = WorkflowNodeKind["kind"];

export type WorkflowNode = WorkflowNodeKind & { id: string; x: number; y: number; join?: "any" | "all" };

export interface WorkflowEdge {
  from: string;
  port: string;
  to: string;
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
}

/** A workflow's run on a task, with the graph it started with. */
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  /** Null once the workflow is deleted. */
  workflow_name: string | null;
  task_id: string;
  source: "status" | "finished" | "manual";
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

/** The ports a node of this kind ends on, which its edges go out of. */
export function workflowPorts(n: WorkflowNodeKind): string[] {
  switch (n.kind) {
    case "trigger":
    case "set_status":
      return ["out"];
    case "condition":
      return ["yes", "no"];
    case "agent":
      return n.output === "verdict" ? ["pass", "issues", "failed"] : ["done", "failed"];
    case "send_to_task":
      return ["exhausted"];
    case "open_pr":
      return ["opened", "exists", "failed"];
  }
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
