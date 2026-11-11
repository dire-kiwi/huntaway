import { Schema } from "effect"
import { ProjectId, TaskId, WorkflowId, WorkflowRunId } from "./ids.ts"
import { Status } from "./task.ts"
import { Timestamp } from "./time.ts"

// A project's workflow and its runs (huntaway's apps/server/src/wire/workflows.ts and packages/client/src/workflows.ts;
// docs/plan/inventory/06-integrations.md 2.1, 3.1): a graph of column nodes and the steps between them that takes a task
// across the board. Without the legacy node kinds (`set_status`, `trigger` on `status`/`finished`), which the server
// reads as column nodes where it takes a graph an agent gives (docs/plan/03-domain.md). Nodes are tagged with `kind`.

/** How a node joins its incoming edges: one taken is enough (`any`, left out when so), or all of them. */
export const WorkflowJoin = Schema.Literals(["any", "all"])
export type WorkflowJoin = typeof WorkflowJoin.Type

/** When a column node's work is done: when the agent's run ends, or when it says so with `finish_work`. */
export const WorkflowDoneWhen = Schema.Literals(["run_end", "finish"])
export type WorkflowDoneWhen = typeof WorkflowDoneWhen.Type

/**
 * `changed`: the workflow hasn't finished a run on the task, or its commit or its agent's work changed since.
 * `has_commits`: its branch has commits of its own. `has_pr`: it has a pull request. `task_type`: it's of type `value`
 * (`code` for a code task). `label`: it has label `value`.
 */
export const WorkflowCheck = Schema.Literals(["changed", "has_commits", "has_pr", "task_type", "label"])
export type WorkflowCheck = typeof WorkflowCheck.Type

/** An agent step's output: its last message (`text`), or a verdict it reports with `submit_review`. */
export const WorkflowOutput = Schema.Literals(["text", "verdict"])
export type WorkflowOutput = typeof WorkflowOutput.Type

/** Where a node is, and how it joins: what every node has. A data node's `label` is the name the editor shows it by. */
const place = {
  id: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
  join: Schema.optionalKey(WorkflowJoin),
  label: Schema.optionalKey(Schema.String),
}

/** Starts a run by hand (`workflows.run`, `run_workflow`). */
export const TriggerNode = Schema.Struct({ kind: Schema.Literal("trigger"), on: Schema.Literal("manual"), ...place })
/**
 * A column of the board. A task entering it starts a run here; `prompt` is what its agent is sent then (In progress:
 * its start prompt; Ready for merge: how to merge). An edge into it moves the task there, ending that path.
 */
export const ColumnNode = Schema.Struct({
  kind: Schema.Literal("column"),
  status: Status,
  prompt: Schema.String,
  done_when: Schema.optionalKey(WorkflowDoneWhen),
  max_rounds: Schema.optionalKey(Schema.Int),
  ...place,
})
export const ConditionNode = Schema.Struct({ kind: Schema.Literal("condition"), check: WorkflowCheck, value: Schema.optionalKey(Schema.String), ...place })
/** An agent in a thread of its own, read-only in the task's worktree. */
export const AgentNode = Schema.Struct({
  kind: Schema.Literal("agent"),
  name: Schema.String,
  prompt: Schema.String,
  output: WorkflowOutput,
  claude_config_id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The project's MCP servers its thread doesn't get. */
  disabled_mcp_servers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The task panel tab its output shows in. */
  tab: Schema.optionalKey(Schema.String),
  /** It's given only the output of the steps before it and its prompt, not where the task's work is. */
  input_only: Schema.optionalKey(Schema.Boolean),
  /** Its thread's conversation goes on from one run to the next. */
  keep_conversation: Schema.optionalKey(Schema.Boolean),
  ...place,
})
/** An A/B test: one of its paths (`a`, `b`, …, one per weight) at random; a task keeps its path unless `each_run`. */
export const SplitNode = Schema.Struct({
  kind: Schema.Literal("split"),
  weights: Schema.Array(Schema.Finite),
  each_run: Schema.optionalKey(Schema.Boolean),
  ...place,
})
/** A message to the task's agent; empty sends the issues the run's verdict steps found. */
export const SendNode = Schema.Struct({ kind: Schema.Literal("send_to_task"), message: Schema.String, max_rounds: Schema.Int, ...place })
/** Pushes the task's branch and opens its pull request; title and body are templates (empty: the defaults). */
export const OpenPrNode = Schema.Struct({
  kind: Schema.Literal("open_pr"),
  title: Schema.String,
  body: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  ...place,
})
// Data nodes: values for other nodes' inputs, through data wires. No run goes into them.
export const TextNode = Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String, ...place })
export const TaskDataNode = Schema.Struct({ kind: Schema.Literal("task"), ...place })
export const ProjectPromptNode = Schema.Struct({ kind: Schema.Literal("project_prompt"), which: Schema.Literals(["start", "review", "merge"]), ...place })
/** A template whose `{{name}}`s without a dot are inputs. */
export const ComposeNode = Schema.Struct({ kind: Schema.Literal("compose"), template: Schema.String, ...place })
export const JoinNode = Schema.Struct({ kind: Schema.Literal("join"), separator: Schema.String, count: Schema.Int, ...place })
export const SwitchNode = Schema.Struct({ kind: Schema.Literal("switch"), check: WorkflowCheck, value: Schema.optionalKey(Schema.String), ...place })

export const WorkflowNode = Schema.Union([
  TriggerNode,
  ColumnNode,
  ConditionNode,
  AgentNode,
  SplitNode,
  SendNode,
  OpenPrNode,
  TextNode,
  TaskDataNode,
  ProjectPromptNode,
  ComposeNode,
  JoinNode,
  SwitchNode,
])
export type WorkflowNode = typeof WorkflowNode.Type
export type WorkflowNodeKindName = WorkflowNode["kind"]

/** The way a run goes from `from`'s `port` to `to`; with `input`, a data wire from `from`'s value `port` to `to`'s input. */
export const WorkflowEdge = Schema.Struct({ from: Schema.String, port: Schema.String, to: Schema.String, input: Schema.optionalKey(Schema.String) })
export interface WorkflowEdge extends Schema.Schema.Type<typeof WorkflowEdge> {}

export const WorkflowGraph = Schema.Struct({ nodes: Schema.Array(WorkflowNode), edges: Schema.Array(WorkflowEdge) })
export interface WorkflowGraph extends Schema.Schema.Type<typeof WorkflowGraph> {}

export const Workflow = Schema.Struct({
  id: WorkflowId,
  project_id: ProjectId,
  name: Schema.String,
  enabled: Schema.Boolean,
  graph: WorkflowGraph,
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Workflow = typeof Workflow.Type

/** What `workflows.create` takes: on by default. */
export const NewWorkflow = Schema.Struct({ project_id: ProjectId, name: Schema.String, graph: WorkflowGraph, enabled: Schema.optional(Schema.Boolean) })
export interface NewWorkflow extends Schema.Schema.Type<typeof NewWorkflow> {}

/** What `workflows.update` takes: any of them. */
export const WorkflowPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  graph: Schema.optional(WorkflowGraph),
  enabled: Schema.optional(Schema.Boolean),
})
export interface WorkflowPatch extends Schema.Schema.Type<typeof WorkflowPatch> {}

export const WorkflowNodeState = Schema.Literals(["pending", "running", "done", "skipped", "failed", "stopped"])
export type WorkflowNodeState = typeof WorkflowNodeState.Type

/** One node's part of a run. Data nodes have none. */
export const WorkflowNodeRun = Schema.Struct({
  state: WorkflowNodeState,
  /** The port it ended on. */
  port: Schema.optionalKey(Schema.String),
  /** An agent step's thread. */
  thread_id: Schema.optionalKey(TaskId),
  /** Who works an agent step, e.g. "Claude · haiku". */
  label: Schema.optionalKey(Schema.String),
  /** An agent step's output, the pull request's URL, an A/B test's path, the message sent, or why it failed. */
  text: Schema.optionalKey(Schema.String),
  /** A verdict step's verdict, set by `submit_review` while it runs. */
  verdict: Schema.optionalKey(Schema.Literals(["pass", "issues"])),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The thread's last run before this step's ("" if none), so an earlier run's late end doesn't end it. */
  after_run: Schema.optionalKey(Schema.String),
  /** Where the run started: a column (which, running, waits for the agent's work there), or the start. */
  start: Schema.optionalKey(Schema.Boolean),
  started_at: Schema.optionalKey(Timestamp),
  finished_at: Schema.optionalKey(Timestamp),
})
export type WorkflowNodeRun = typeof WorkflowNodeRun.Type

/** What started a run: the task entering a column, its agent's work there done, its merge, or a run by hand. */
export const WorkflowRunSource = Schema.Literals(["status", "finished", "merged", "manual"])
export type WorkflowRunSource = typeof WorkflowRunSource.Type

export const WorkflowRunState = Schema.Literals(["running", "done", "stopped"])
export type WorkflowRunState = typeof WorkflowRunState.Type

/** A workflow's run on a task, with the graph it started with. */
export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflow_id: WorkflowId,
  /** Null once the workflow is deleted. */
  workflow_name: Schema.NullOr(Schema.String),
  task_id: TaskId,
  source: WorkflowRunSource,
  state: WorkflowRunState,
  /** The task's commit when it started. */
  head: Schema.NullOr(Schema.String),
  graph: WorkflowGraph,
  nodes: Schema.Record(Schema.String, WorkflowNodeRun),
  /** Sends in a row per send node (and In progress), carried from one run to the next. */
  rounds: Schema.Record(Schema.String, Schema.Int),
  /** Why it was stopped. */
  detail: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  finished_at: Schema.NullOr(Timestamp),
})
export interface WorkflowRun extends Schema.Schema.Type<typeof WorkflowRun> {}

/** A task's workflow runs (the latest of each workflow, and the earlier ones its tabs show), and its project's workflows. */
export const TaskWorkflowRuns = Schema.Struct({
  runs: Schema.Array(WorkflowRun),
  workflows: Schema.Array(Schema.Struct({ id: WorkflowId, name: Schema.String, enabled: Schema.Boolean })),
})
export interface TaskWorkflowRuns extends Schema.Schema.Type<typeof TaskWorkflowRuns> {}

// The graph's vocabulary, which the server and the editor share.

/** The kinds of data nodes, which only give values to other nodes' inputs. */
export const WORKFLOW_DATA_KINDS: ReadonlyArray<WorkflowNodeKindName> = ["text", "task", "project_prompt", "compose", "join", "switch"]
/** An A/B test's ports, one for each of its paths: `a` is path A. */
export const WORKFLOW_PATHS: ReadonlyArray<string> = ["a", "b", "c", "d", "e", "f", "g", "h"]
/** Most an A/B test's path can weigh. */
export const WORKFLOW_MAX_WEIGHT = 1000
/** How many times in a row edges into In progress give the agent its work, for a column node without `max_rounds`. */
export const COLUMN_ROUNDS = 3
/** Most inputs a join takes. */
export const MAX_JOIN = 8

/** Whether it's a data node, which gives values and no run goes into. */
export const isDataNode = (n: Pick<WorkflowNode, "kind">): boolean => WORKFLOW_DATA_KINDS.includes(n.kind)

/** The `{{name}}`s of a compose template that are its inputs: those without a dot, in order. */
export const templateInputs = (t: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const m of t.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = m[1]
    if (name !== undefined && !out.includes(name)) out.push(name)
  }
  return out
}

/** The inputs a node takes values on, which a data wire replaces its own text in. */
export const workflowDataInputs = (n: WorkflowNode): ReadonlyArray<string> => {
  switch (n.kind) {
    case "column":
      return n.status === "needs_attention" || n.status === "done" ? [] : ["prompt"]
    case "agent":
      return ["prompt"]
    case "send_to_task":
      return ["message"]
    case "open_pr":
      return ["title", "body"]
    case "compose":
      return templateInputs(n.template)
    case "join":
      return Array.from({ length: Math.min(Math.max(n.count, 1), MAX_JOIN) }, (_, i) => `in${i + 1}`)
    case "switch":
      return ["yes", "no"]
    case "trigger":
    case "condition":
    case "split":
    case "text":
    case "task":
    case "project_prompt":
    default:
      return []
  }
}

/** The values a node gives other nodes' inputs. */
export const workflowDataOutputs = (n: WorkflowNode): ReadonlyArray<string> => {
  switch (n.kind) {
    case "agent":
      return ["text", "issues", "verdict"]
    case "open_pr":
      return ["url"]
    case "split":
      return ["path"]
    case "column":
      return ["next"]
    case "task":
      return ["title", "description", "key", "branch", "commit", "pr", "labels"]
    case "text":
    case "project_prompt":
    case "compose":
    case "join":
    case "switch":
      return ["text"]
    case "trigger":
    case "condition":
    case "send_to_task":
    default:
      return []
  }
}

/** The ports a node ends on, which its flow edges go out of. */
export const workflowPorts = (n: WorkflowNode): ReadonlyArray<string> => {
  switch (n.kind) {
    case "trigger":
      return ["out"]
    case "column":
      return ["done"]
    case "condition":
      return ["yes", "no"]
    case "agent":
      return n.output === "verdict" ? ["pass", "issues", "failed"] : ["done", "failed"]
    case "send_to_task":
      return ["sent", "exhausted"]
    case "open_pr":
      return ["opened", "exists", "failed"]
    case "split":
      return WORKFLOW_PATHS.slice(0, Math.min(Math.max(n.weights.length, 0), WORKFLOW_PATHS.length))
    case "text":
    case "task":
    case "project_prompt":
    case "compose":
    case "join":
    case "switch":
    default:
      return []
  }
}

/** The data wire into node `id`'s input `input`, if any. */
export const workflowWire = (g: Pick<WorkflowGraph, "edges">, id: string, input: string): WorkflowEdge | undefined =>
  g.edges.find((e) => e.to === id && e.input === input)

/**
 * Whether the task's agent works in column node `n`'s column, so that its `done` waits for that work: In progress,
 * Ready for merge (its merge), and any other column with a prompt (or a wire into it).
 */
export const workflowWaits = (n: WorkflowNode, g: Pick<WorkflowGraph, "edges">): boolean =>
  n.kind === "column" &&
  (n.status === "in_progress" || n.status === "ready_for_merge" || n.prompt.trim() !== "" || workflowWire(g, n.id, "prompt") !== undefined)

/** The column node a run waits at for the task's agent's work there, which it was sent the prompt of. */
export const workflowWaitingAt = (r: Pick<WorkflowRun, "graph" | "nodes" | "state">): Extract<WorkflowNode, { readonly kind: "column" }> | null => {
  if (r.state !== "running") return null
  for (const n of r.graph.nodes) if (n.kind === "column" && r.nodes[n.id]?.start === true && r.nodes[n.id]?.state === "running") return n
  return null
}

/** The columns a workflow has nodes for. */
export const workflowColumns = (g: WorkflowGraph): ReadonlyArray<Status> => g.nodes.flatMap((n) => (n.kind === "column" ? [n.status] : []))
