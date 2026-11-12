import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { ProjectId, TaskId, WorkflowId, WorkflowRunId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { NewWorkflow, TaskWorkflowRuns, Workflow, WorkflowPatch, WorkflowRun } from "../workflow.ts"

/**
 * A project's workflows and their runs (the old `/projects/{id}/workflows`, `/workflows/{id}`, `/workflows/{id}/run`,
 * `/tasks/{id}/workflow-runs`, `/workflow-runs/{id}/stop`). A change emits `workflows_changed`; a run's change
 * `workflow_runs_changed`.
 */
export class WorkflowRpcs extends RpcGroup.make(
  Rpc.make("workflows.list", { payload: { project_id: ProjectId }, success: Schema.Array(Workflow), error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("workflows.get", { payload: { id: WorkflowId }, success: Workflow, error: NotFound }).annotate(RequiredScope, "read"),
  /** Checked against the project; a column where the agent works belongs to one workflow that's on (`Conflict`). */
  Rpc.make("workflows.create", { payload: { workflow: NewWorkflow }, success: Workflow, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "settings",
  ),
  /** Runs in progress go on with the graph they started with; turned off, its runs waiting at a column stop. */
  Rpc.make("workflows.update", {
    payload: { id: WorkflowId, patch: WorkflowPatch },
    success: Workflow,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  /** Stops its runs in progress; their threads stay with their tasks. */
  Rpc.make("workflows.delete", { payload: { id: WorkflowId }, error: NotFound }).annotate(RequiredScope, "settings"),
  /** Runs it on one of its project's tasks now, on or off and whatever its trigger, with fresh rounds. */
  Rpc.make("workflows.run", {
    payload: { id: WorkflowId, task_id: TaskId },
    success: WorkflowRun,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /** The latest run of each workflow on the task (and the earlier ones its tabs show), and its project's workflows. */
  Rpc.make("workflows.runsOfTask", { payload: { task_id: TaskId }, success: TaskWorkflowRuns, error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("workflows.stopRun", { payload: { id: WorkflowRunId }, success: Schema.Struct({ stopped: Schema.Boolean }), error: NotFound }).annotate(
    RequiredScope,
    "operate",
  ),
).middleware(Auth) {}
