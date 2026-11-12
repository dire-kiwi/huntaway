import { Effect, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { Effort, Status } from "@huntaway/contracts"
import type { Project, Workflow, WorkflowGraph } from "@huntaway/contracts"
import { readGraph } from "../../workflows/read.ts"
import { MAX_ROUNDS } from "../../workflows/graph.ts"
import { WorkflowApprovals } from "../../workflows/WorkflowApprovals.ts"
import { WorkflowEngine } from "../../workflows/WorkflowEngine.ts"
import { Workflows } from "../../workflows/Workflows.ts"
import { makeReach } from "../resolve.ts"
import { ApprovalKind, ForPlanning, ownThread, Rerunnable, ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { boardTool, given, Json, PROJECT_ONE, ProfileArg, told } from "./common.ts"

// The workflow tools (docs/plan/inventory/06-integrations.md 7; the old mcp/schemas/workflows.ts and mcp/tools/
// workflows.ts): listing, creating, changing, deleting and running a project's workflows. Creating one, changing what it
// does or turning it on, and deleting one ask the user first (`WorkflowApprovals`).

const workflowRef = Schema.String.annotate({ description: "The workflow's id, or its name in project_id (see list_workflows)" })
const projectArg = Schema.String.annotate({ description: PROJECT_ONE })

const GRAPH =
  "The workflow's nodes and the edges between them: a task's way across the board, column by column. A run starts at a column node (or at the start, " +
  "for a run by hand) and follows edges out of the port each node ends on. A node runs once every node with an edge into it has finished and one of those " +
  "edges was taken (join 'any', the default) or all of them (join 'all'); otherwise it's skipped. An edge into a column node moves the task there, which " +
  "ends that path: the column's own outcome is the next run's. No loops but through a column (or by sending to the task's agent). Node kinds and their ports: " +
  "{kind: 'column', status, prompt, done_when, max_rounds} (one per column) → done. A task entering the column starts a run there. prompt (a template) is what the " +
  "task's agent is sent then, with what the board does once its work is done (the steps after done): for in_progress it's the task's start prompt " +
  "(empty: the project's), and an edge into in_progress gives a started task the issues the run found, or else the prompt (empty: the project's start prompt), at most max_rounds (default 3) runs in a row, then needs_attention; for ready_for_merge it's how " +
  "the agent merges. done comes when that work is: for in_progress and a column with a prompt, when the agent's run ends (a question for the user or a " +
  "failure leaves it in needs_attention, waiting), or with done_when 'finish' only once the agent calls finish_work in its turn (without it, " +
  "needs_attention); for ready_for_merge once the task is merged; elsewhere at once. Meanwhile the task stays in In progress rather than going to " +
  "In review; a run that ends without moving it sends it to In review, or needs_attention if a step failed or it was stopped. A column whose agent works " +
  "there (in_progress, ready_for_merge, or one with a prompt) belongs to one workflow that's on; needs_attention and done have no prompt, and only " +
  "ready_for_merge's done (and the steps after it) goes into done: with one, the merging agent is told to call finish_work once it's merged, and the workflow moves the task to done (without one, the agent sets it done itself). {kind: 'trigger', on: 'manual'} (at most one) starts runs by hand (run_workflow, or Run on the board; without one, a run by hand " +
  "starts at the node for the task's column) → out; " +
  "{kind: 'condition', check: 'changed'|'has_commits'|'has_pr'|'task_type'|'label', value} → yes, no ('changed': its commit or its agent's work changed since this workflow last finished on it; " +
  "value is the type, code or scratch, or the label, plan, artifact or diagram); " +
  "{kind: 'agent', name, prompt, output: 'text'|'verdict', claude_config_id, model, effort, skills, disabled_mcp_servers, tab, input_only, keep_conversation} runs an agent read-only in the task's worktree, in a thread of its own " +
  "(skills: skills it's asked to use; disabled_mcp_servers: names of the project's MCP servers its thread doesn't get) " +
  "and a fresh conversation each run (with keep_conversation, the conversation its thread had last run goes on, while its agent is the same), given the output of the agent steps before it in the graph (with input_only, only that and its prompt, not where the task's work is): " +
  "output 'text' → done, failed (its last message is the output); 'verdict' → pass, issues, failed (it reports with submit_review, as a reviewer does). " +
  "With tab, its output shows in a tab of that name in the task's panel (steps can share one). prompt says what to do (empty: the project's In review prompt for a verdict); " +
  "prompts and messages take {{task.key}}, {{task.title}}, {{task.description}}, {{branch}}, {{commit}}, {{workflow}}, {{issues}} and {{<node id>.text}}, {{<node id>.issues}}; " +
  "{kind: 'split', weights, each_run} is an A/B test, to compare reviewers say: 2 to 8 paths, ports a, b, c… (one for each weight, 0 to 1000), and a run takes one " +
  "at random, path i as likely as weights[i] out of their sum; a task keeps the path it took the last time a run reached the test, unless each_run picks again each run; " +
  "its value path (and {{<node id>.path}}) is the path it took, A, B…; " +
  "{kind: 'send_to_task', message, max_rounds} sends the message (empty: the issues the run's verdict steps found) to the task's agent, ending the run, " +
  "at most max_rounds runs in a row (default 2), then → exhausted (with nothing after it, the task goes to needs_attention); " +
  "{kind: 'open_pr', title, body, draft} pushes the task's branch and opens its pull request with the gh tools (title and body are templates; empty: '<task key>: <task title>', and the task's agent's last message, or else its description) " +
  "→ opened, exists (it has one already, which gets the branch's new commits), failed; while one comes after In progress's done, the agent isn't told to open one. " +
  "Data wires build prompts: an edge with input, {from, port, to, input}, gives node to's input (one wire each) the value port of node from, in place of " +
  "the input's own text: column prompt, agent prompt, send_to_task message, open_pr title and body, a compose node's {{name}}s (without a dot), a join's " +
  "in1…in<count>, a switch's yes and no. Values: agent text, issues, verdict (from the run, or else the workflow's latest run on the task that ran it, so " +
  "In progress's prompt can take the last review's issues); open_pr url; column next (what the board does once its work is done, which is added to its " +
  "prompt unless next is wired somewhere); and data nodes, which no run goes into: {kind: 'text', text} → text (a template); {kind: 'task'} → title, " +
  "description, key, branch, commit, pr, labels; {kind: 'project_prompt', which: 'start'|'review'|'merge'} → text; {kind: 'compose', template} → text; " +
  "{kind: 'join', separator, count} → text (its inputs with text, separated; \\n is a newline); {kind: 'switch', check: 'has_pr'|'task_type'|'label', " +
  "value} → text (its yes or no). Values can't go round in a loop among data nodes. " +
  "The kinds from before column nodes, {kind: 'trigger', on: 'status', status}, {kind: 'trigger', on: 'finished'} and {kind: 'set_status', status}, are read as column nodes. " +
  "Each node has an id (letters, digits, - and _), and x and y for where the editor draws it; a data node can have a label, the name the editor shows it by."

const o = Schema.optionalKey
const NodeArg = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "column",
    "trigger",
    "condition",
    "agent",
    "split",
    "send_to_task",
    "open_pr",
    "text",
    "task",
    "project_prompt",
    "compose",
    "join",
    "switch",
    // From before column nodes, read as column nodes (`readGraph`), as GRAPH says.
    "set_status",
  ]),
  on: o(Schema.Literals(["manual", "status", "finished"])),
  status: o(Status),
  check: o(Schema.Literals(["changed", "has_commits", "has_pr", "task_type", "label"])),
  value: o(Schema.String),
  name: o(Schema.String),
  prompt: o(Schema.String),
  output: o(Schema.Literals(["text", "verdict"])),
  claude_config_id: o(Schema.String),
  model: o(Schema.String),
  effort: o(Effort),
  skills: o(Schema.Array(Schema.String)),
  disabled_mcp_servers: o(Schema.Array(Schema.String)),
  tab: o(Schema.String),
  input_only: o(Schema.Boolean),
  keep_conversation: o(Schema.Boolean),
  weights: o(Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))).check(Schema.isMinLength(2), Schema.isMaxLength(8))),
  each_run: o(Schema.Boolean),
  done_when: o(Schema.Literals(["run_end", "finish"])),
  title: o(Schema.String),
  body: o(Schema.String),
  draft: o(Schema.Boolean),
  text: o(Schema.String),
  which: o(Schema.Literals(["start", "review", "merge"])),
  template: o(Schema.String),
  separator: o(Schema.String),
  count: o(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  message: o(Schema.String),
  max_rounds: o(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ROUNDS }))),
  join: o(Schema.Literals(["any", "all"])),
  label: o(Schema.String),
  x: o(Schema.Finite),
  y: o(Schema.Finite),
})
const EdgeArg = Schema.Struct({ from: Schema.String, port: Schema.String, to: Schema.String, input: o(Schema.String) })
const GraphArg = Schema.Struct({ nodes: Schema.Array(NodeArg), edges: Schema.Array(EdgeArg) }).annotate({ description: GRAPH })

const ASKS = "It asks the user to approve it first (say why in reason): the call waits for their answer, and if they don't approve it nothing changes."
const reasonArg = Schema.String.annotate({ description: "Why, shown to the user when they're asked to approve it" })

export const ListWorkflows = Tool.make("list_workflows", {
  description:
    "List a project's workflows: graphs of a task's columns and the steps between them (conditions, agent steps that review or report on a task's work, pull requests, messages to the task's agent) that run on its tasks as they move across the board, or by hand. Each comes with its graph.",
  parameters: Schema.Struct({ project_id: o(projectArg), profile: o(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

export const CreateWorkflow = Tool.make("create_workflow", {
  description: `Add a workflow to a project, such as a review that sends the issues it finds back to the task's agent, or a summary shown in a tab of the task. Only when the user asks for one. ${ASKS}`,
  parameters: Schema.Struct({
    project_id: o(projectArg),
    profile: o(ProfileArg),
    name: Schema.String,
    graph: GraphArg,
    enabled: o(Schema.Boolean.annotate({ description: "On straight away (default true)" })),
    reason: o(reasonArg),
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const UpdateWorkflow = Tool.make("update_workflow", {
  description: `Change a project's workflow; leave out what to keep (graph replaces the whole graph). Turning it off or renaming it is done straight away; any other change, including turning it on, asks the user. ${ASKS} Runs in progress go on with the graph they started with.`,
  parameters: Schema.Struct({
    workflow_id: workflowRef,
    project_id: o(projectArg),
    profile: o(ProfileArg),
    name: o(Schema.String),
    graph: o(GraphArg),
    enabled: o(Schema.Boolean),
    reason: o(reasonArg),
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const DeleteWorkflow = Tool.make("delete_workflow", {
  description: `Delete a project's workflow, stopping its runs in progress (their threads stay with their tasks). Only when the user asks for it. ${ASKS}`,
  parameters: Schema.Struct({
    workflow_id: workflowRef,
    project_id: o(projectArg),
    profile: o(ProfileArg),
    reason: o(Schema.String.annotate({ description: "Why, shown to the user when they're asked to confirm" })),
  }),
  success: Json,
}).annotate(ApprovalKind, "automation")

export const RunWorkflow = Tool.make("run_workflow", {
  description:
    "Run a workflow on one of its project's tasks now, on or off and whatever its trigger, with fresh rounds. Returns the run as it is once its first steps started: its state and each node's (get_task shows the task's latest runs later).",
  parameters: Schema.Struct({
    workflow_id: workflowRef,
    task_id: Schema.String.annotate({ description: "The task to run it on: an id or key of a task in the workflow's project" }),
    project_id: o(projectArg),
    profile: o(ProfileArg),
  }),
  success: Json,
})

/** A graph an agent gave, read as the board keeps it (its kinds' defaults, the old kinds as column nodes). */
const graphOf = (v: unknown): Effect.Effect<WorkflowGraph, ToolError> => {
  const g = readGraph(v)
  return Result.isSuccess(g) ? Effect.succeed(g.success) : Effect.fail(ToolError.other(`graph: ${g.failure}`))
}

/** The workflow tools' handlers. */
/** Who the user is asked for: the calling agent's own thread (an agent on another host has none here, M7's). */
const askerOf = (caller: McpCaller, tool: string) => Effect.map(ownThread(caller, tool), (c) => ({ run: c.run, call_id: c.call_id }))

export const workflowTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const workflows = yield* Workflows
  const approvals = yield* WorkflowApprovals
  const engine = yield* WorkflowEngine

  /** The workflow an agent names in `workflow_id`: its id, or its name in `project_id` (or the agent's own project). */
  const resolve = Effect.fnUntraced(function* (caller: McpCaller, ref: string, projectId: string | null, profile: string | null) {
    const r = ref.trim()
    const byId = yield* Effect.result(workflows.get(r))
    if (Result.isSuccess(byId)) {
      const p = yield* reach.project(caller, byId.success.project_id, null).pipe(Effect.mapError(() => ToolError.notFound(`workflow ${r}`)))
      return [byId.success, p] as const
    }
    const p = yield* reach.projectOrOwn(caller, projectId, profile)
    const named = (yield* workflows.list(p.id).pipe(told)).filter((w) => w.name.toLowerCase() === r.toLowerCase())
    if (named.length === 0) return yield* ToolError.notFound(`workflow ${r} in ${p.key} (use list_workflows)`)
    const [one] = named
    if (named.length > 1 || one === undefined) return yield* ToolError.other(`${p.key} has several workflows named ${r}; give its id (see list_workflows)`)
    return [one, p] as const
  })

  const listWorkflows = boardTool(ListWorkflows, (params, caller) =>
    Effect.gen(function* () {
      const p = yield* reach.projectOrOwn(caller, given(params.project_id), given(params.profile))
      return { project: { id: p.id, key: p.key, name: p.name }, workflows: yield* workflows.list(p.id).pipe(told) }
    }),
  )

  const createWorkflow = boardTool(CreateWorkflow, (params, caller) =>
    Effect.gen(function* () {
      // Read only when the call hasn't asked before (a retried call carries on with the approval it asked for).
      const request = Effect.gen(function* () {
        const project: Project = yield* reach.projectOrOwn(caller, given(params.project_id), given(params.profile))
        return { project, name: params.name, graph: yield* graphOf(params.graph), enabled: params.enabled ?? true, reason: given(params.reason) }
      })
      const w: Workflow = yield* approvals.create(yield* askerOf(caller, "create_workflow"), request).pipe(told)
      return w
    }),
  )

  const updateWorkflow = boardTool(UpdateWorkflow, (params, caller) =>
    Effect.gen(function* () {
      const request = Effect.gen(function* () {
        const [workflow, project] = yield* resolve(caller, params.workflow_id, given(params.project_id), given(params.profile))
        return {
          workflow,
          project,
          name: params.name ?? null,
          graph: params.graph === undefined ? null : yield* graphOf(params.graph),
          enabled: params.enabled ?? null,
          reason: given(params.reason),
        }
      })
      const w: Workflow = yield* approvals.update(yield* askerOf(caller, "update_workflow"), request).pipe(told)
      return w
    }),
  )

  const deleteWorkflow = boardTool(DeleteWorkflow, (params, caller) =>
    Effect.gen(function* () {
      const request = Effect.gen(function* () {
        const [workflow, project] = yield* resolve(caller, params.workflow_id, given(params.project_id), given(params.profile))
        return { workflow, project, reason: given(params.reason) }
      })
      return yield* approvals.delete(yield* askerOf(caller, "delete_workflow"), request).pipe(told)
    }),
  )

  const runWorkflow = boardTool(RunWorkflow, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      const [w, p] = yield* resolve(caller, params.workflow_id, given(params.project_id), profile)
      const r = params.task_id.trim()
      const t = yield* reach.task(caller, r, profile).pipe(Effect.mapError((e) => (e.notFound ? ToolError.other(`task ${r} not found in ${p.key}`) : e)))
      if (t.project_id !== p.id) return yield* ToolError.other(`task ${r} isn't in ${p.key}, the workflow's project`)
      return yield* engine.run(w.id, t.id).pipe(
        Effect.catchTags({
          WorkflowRefused: (e) => Effect.fail(ToolError.other(e.reason)),
          NotFound: (e) => Effect.fail(ToolError.notFound(`${e.what} ${e.id}`)),
        }),
      )
    }),
  )

  return { listWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, runWorkflow }
})
