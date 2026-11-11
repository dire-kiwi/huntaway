import { Schema } from "effect"
import { AgentConfigId, ProfileId, ProjectId, RequestId, TaskId } from "./ids.ts"
import { Status } from "./task.ts"
import { Timestamp } from "./time.ts"

// What an agent waits for the user to approve, whatever its thread's permission mode (huntaway's
// apps/server/src/wire/approvals.ts, as `GET /project-approvals` listed it): the board snapshot's `approvals`. `kind`
// says what it is, each with its own `input`. A workflow's approval says `workflow` (the old one said `automation`).

/** A project as an approval names it; `host` is the linked host it is on. */
const ProjectRef = Schema.Struct({ id: ProjectId, key: Schema.String, name: Schema.String, host: Schema.NullOr(Schema.String) })

/** The thread that asked. */
const AskedBy = Schema.NullOr(Schema.Struct({ id: TaskId, key: Schema.NullOr(Schema.String), title: Schema.String }))

/** Why, in the agent's words. */
const Reason = Schema.NullOr(Schema.String)

/** What an agent asked to change about a project. */
export const ProjectChange = Schema.Struct({
  project: ProjectRef,
  task: AskedBy,
  /** Each setting it changes, and whether that one needs the user. */
  changes: Schema.Array(Schema.Struct({ field: Schema.String, from: Schema.Unknown, to: Schema.Unknown, needs_approval: Schema.Boolean })),
  reason: Reason,
})
export interface ProjectChange extends Schema.Schema.Type<typeof ProjectChange> {}

/** A project an agent asked to add: the folder its agents would work in. */
export const ProjectCreation = Schema.Struct({
  op: Schema.Literal("create"),
  /** As it would be added (it has no id yet). */
  project: ProjectRef,
  task: AskedBy,
  /** The profile whose board it is added to. */
  board: Schema.String,
  /** The folder, with symlinks resolved. */
  repo_path: Schema.String,
  /** False when the folder is made. */
  exists: Schema.Boolean,
  git: Schema.Boolean,
  /** The permission mode its tasks get: the host's default. */
  permission_mode: Schema.String,
  reason: Reason,
})
export interface ProjectCreation extends Schema.Schema.Type<typeof ProjectCreation> {}

/** A task an agent asked to delete. */
export const TaskDeletion = Schema.Struct({
  project: Schema.NullOr(ProjectRef),
  task: AskedBy,
  delete: Schema.Struct({
    id: TaskId,
    key: Schema.String,
    title: Schema.String,
    status: Status,
    branch: Schema.NullOr(Schema.String),
    running: Schema.Boolean,
  }),
  /** The branch is deleted too. */
  delete_branch: Schema.Boolean,
  reason: Reason,
})
export interface TaskDeletion extends Schema.Schema.Type<typeof TaskDeletion> {}

/** An automation as its approval shows it, with the task its message goes to and its tasks' agent config. */
export const AutomationView = Schema.Struct({
  /** Empty for one being created. */
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  /** The automation's `Trigger` and `Action` (declared with automations). */
  trigger: Schema.Unknown,
  action: Schema.Unknown,
  /** A webhook's deliveries must be signed with a secret. */
  signed: Schema.Boolean,
  target: Schema.NullOr(Schema.Struct({ id: TaskId, key: Schema.String, title: Schema.String, status: Status })),
  config: Schema.NullOr(Schema.Struct({ id: AgentConfigId, name: Schema.String, agent: Schema.String })),
  /** What a run is checked against first: the automation's `ActiveHours`, a precheck command, a budget. */
  active_hours: Schema.Unknown,
  precheck: Schema.NullOr(Schema.String),
  budget_usd: Schema.NullOr(Schema.Finite),
})
export interface AutomationView extends Schema.Schema.Type<typeof AutomationView> {}

export const ChangeOp = Schema.Literals(["create", "update", "delete"])
export type ChangeOp = typeof ChangeOp.Type

/** An automation an agent asked to create, change or delete. */
export const AutomationChange = Schema.Struct({
  op: ChangeOp,
  /** A project's automation. */
  project: Schema.NullOr(ProjectRef),
  /** A profile's routine. */
  profile: Schema.NullOr(Schema.Struct({ id: ProfileId, name: Schema.String, host: Schema.NullOr(Schema.String) })),
  task: AskedBy,
  /** As it would be (or, to delete, as it is). */
  automation: AutomationView,
  /** For a change: as it is. */
  before: Schema.NullOr(AutomationView),
  /** For a change: name, trigger, action, enabled, generate_secret, secret or rotate_token. */
  changes: Schema.NullOr(Schema.Array(Schema.String)),
  /** The host's time zone, which times of day are in. */
  time_zone: Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String), offset: Schema.String })),
  reason: Reason,
})
export interface AutomationChange extends Schema.Schema.Type<typeof AutomationChange> {}

/** A workflow as its approval shows it, with its agent steps' configs by name. */
export const WorkflowView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  /** The workflow's `Graph` (declared with workflows). */
  graph: Schema.Unknown,
  configs: Schema.Array(Schema.Struct({ node: Schema.String, id: AgentConfigId, name: Schema.String, agent: Schema.String })),
})
export interface WorkflowView extends Schema.Schema.Type<typeof WorkflowView> {}

/** A workflow an agent asked to create, change or delete. */
export const WorkflowChange = Schema.Struct({
  op: ChangeOp,
  project: ProjectRef,
  task: AskedBy,
  workflow: WorkflowView,
  before: Schema.NullOr(WorkflowView),
  /** For a change: name, graph or enabled. */
  changes: Schema.NullOr(Schema.Array(Schema.String)),
  reason: Reason,
})
export interface WorkflowChange extends Schema.Schema.Type<typeof WorkflowChange> {}

export const ApprovalStatus = Schema.Literals(["pending", "allowed", "denied", "expired"])
export type ApprovalStatus = typeof ApprovalStatus.Type

const Request = {
  request_id: RequestId,
  status: ApprovalStatus,
  /** What the user said with their answer. */
  note: Schema.NullOr(Schema.String),
  /** The thread that asked. */
  task_id: TaskId,
  created_at: Timestamp,
}

/** What only the user decides for an agent. `tool` is a tool call its thread's mode or an approval rule asks about. */
export const Approval = Schema.Union([
  Schema.Struct({ ...Request, kind: Schema.Literal("tool"), tool_name: Schema.String, input: Schema.Unknown }),
  Schema.Struct({ ...Request, kind: Schema.Literal("project"), tool_name: Schema.Literal("update_project"), input: ProjectChange }),
  Schema.Struct({ ...Request, kind: Schema.Literal("project"), tool_name: Schema.Literal("create_project"), input: ProjectCreation }),
  Schema.Struct({ ...Request, kind: Schema.Literal("delete_task"), tool_name: Schema.Literal("delete_task"), input: TaskDeletion }),
  Schema.Struct({
    ...Request,
    kind: Schema.Literal("automation"),
    tool_name: Schema.Literals(["create_automation", "update_automation", "delete_automation"]),
    input: AutomationChange,
  }),
  Schema.Struct({
    ...Request,
    kind: Schema.Literal("workflow"),
    tool_name: Schema.Literals(["create_workflow", "update_workflow", "delete_workflow"]),
    input: WorkflowChange,
  }),
])
export type Approval = typeof Approval.Type
