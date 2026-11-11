import { Schema } from "effect"
import { AgentConfigId, ProfileId, ProjectId, RequestId, TaskId } from "./ids.ts"
import { PermissionMode, Status } from "./task.ts"
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

// A profile's approval rules and its action log (huntaway's wire/approval_rules.ts; docs/plan/inventory/02-agent-support.md
// 2.6): for each tool or MCP server, the profile's assistant and the threads under it may use it (allow), ask the user
// first (ask) or never do (never), whatever their mode. `@huntaway/shared` matches them.

export const RuleDecision = Schema.Literals(["allow", "ask", "never"])
export type RuleDecision = typeof RuleDecision.Type

export const ApprovalRule = Schema.Struct({
  /**
   * A tool's name (`mcp__google__send_gmail_message`, `Bash`), an MCP server's prefix for all its tools (`mcp__google`),
   * or a pattern where `*` stands for anything (`mcp__google__*delete*`), matched without regard to case.
   */
  tool: Schema.String,
  decision: RuleDecision,
})
export interface ApprovalRule extends Schema.Schema.Type<typeof ApprovalRule> {}

/** A profile's rules, as stored (`profiles.approval_rules`). */
export const ApprovalRuleSet = Schema.Struct({
  rules: Schema.Array(ApprovalRule),
  /** Minutes until a prompt raised by a routine run is denied; 0 never. */
  expiry_minutes: Schema.Int,
})
export interface ApprovalRuleSet extends Schema.Schema.Type<typeof ApprovalRuleSet> {}

/** A profile's rules as Settings shows them (`approvalRules.get`, the old `GET /profiles/{id}/approval-rules`). */
export const ApprovalRulesView = Schema.Struct({
  ...ApprovalRuleSet.fields,
  /** They're the defaults: the profile hasn't changed them. */
  is_default: Schema.Boolean,
  defaults: ApprovalRuleSet,
  /** The board's MCP server's name, whose tools a rule names as `mcp__<board_server>__<tool>`. */
  board_server: Schema.String,
  /** The MCP server name the Google defaults are for. */
  google_server: Schema.String,
  /** The board's tools that create tasks, which an optional rule asks about. */
  create_task_tools: Schema.Array(Schema.String),
})
export interface ApprovalRulesView extends Schema.Schema.Type<typeof ApprovalRulesView> {}

/** What `approvalRules.set` changes: the rules, the expiry, or both (what is left out stays); or `reset` to the defaults. */
export const ApprovalRulesUpdate = Schema.Struct({
  rules: Schema.optional(Schema.Array(ApprovalRule)),
  expiry_minutes: Schema.optional(Schema.Int),
  reset: Schema.optional(Schema.Boolean),
})
export interface ApprovalRulesUpdate extends Schema.Schema.Type<typeof ApprovalRulesUpdate> {}

/** What became of a call a rule asked about or turned away. */
export const ActionOutcome = Schema.Literals(["pending", "allowed", "denied", "expired", "blocked"])
export type ActionOutcome = typeof ActionOutcome.Type

/**
 * Who settled it: `user` (on the board), `push` (a notification), `telegram` (its buttons, on an imported board),
 * `expiry` (nobody, in time), `mode` (Don't ask), `rule`, or `ended` (its run ended first).
 */
export const AnsweredBy = Schema.Literals(["user", "push", "telegram", "expiry", "mode", "rule", "ended"])
export type AnsweredBy = typeof AnsweredBy.Type

/** A call that hit an ask or never rule: a row of the action log (`approval_log`). */
export const ApprovalAction = Schema.Struct({
  id: Schema.String,
  task_id: TaskId,
  /** The prompt it raised, for an ask. */
  request_id: Schema.NullOr(RequestId),
  tool_name: Schema.String,
  /** What it was called with, in a line. */
  summary: Schema.String,
  /** The rule that matched it. */
  rule: Schema.String,
  decision: Schema.Literals(["ask", "never"]),
  outcome: ActionOutcome,
  answered_by: Schema.NullOr(AnsweredBy),
  created_at: Timestamp,
  decided_at: Schema.NullOr(Timestamp),
})
export interface ApprovalAction extends Schema.Schema.Type<typeof ApprovalAction> {}

// Prompts waiting for the user (the old `GET /permissions` and `POST /permissions/{id}`, huntaway's wire/permissions.ts):
// a tool call its thread's mode or an approval rule asks about, a question, a plan, or one of the board's own approvals.

/** A prompt waiting for an answer, as `permissions.pending` lists it. `input` is what the agent asked with. */
export const PendingPermission = Schema.Struct({
  id: RequestId,
  task_id: TaskId,
  tool_name: Schema.String,
  input: Schema.Unknown,
  created_at: Timestamp,
  /** A routine run's prompt is denied at this time if nobody answers it. */
  expires_at: Schema.NullOr(Timestamp),
  /** The approval rule that asked it, if one did. */
  rule: Schema.NullOr(Schema.String),
})
export interface PendingPermission extends Schema.Schema.Type<typeof PendingPermission> {}

/** allow, allow this tool in the thread from now on too, or deny. */
export const PermissionDecision = Schema.Literals(["allow", "allow_always", "deny"])
export type PermissionDecision = typeof PermissionDecision.Type

/** The user's answer to a prompt (the old `POST /permissions/{id}` body). */
export const PermissionAnswer = Schema.Struct({
  decision: PermissionDecision,
  /** deny: what the agent is told. */
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A question, allowed: each question's answers, in order (a chosen option's label or what the user typed). */
  answers: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Array(Schema.String)))),
  /** A plan, approved: the mode the thread carries on in (not `plan`). */
  mode: Schema.optionalKey(Schema.NullOr(PermissionMode)),
  /** A plan, denied: what the user wants changed. */
  feedback: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** An automation that creates tasks, approved: the model and effort its tasks run with (left out: as the agent asked). */
  automation: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ model: Schema.optionalKey(Schema.NullOr(Schema.String)), effort: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
})
export interface PermissionAnswer extends Schema.Schema.Type<typeof PermissionAnswer> {}

/** What a prompt came to once answered. */
export const PermissionAnswered = Schema.Struct({ status: Schema.Literals(["allowed", "denied"]) })
export interface PermissionAnswered extends Schema.Schema.Type<typeof PermissionAnswered> {}
