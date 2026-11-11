// The shapes of the central wire types, as packages/contracts will declare them. Type-checked against effect 4.1.4.
// Field names are the old API's (apps/server/src/wire/*.ts in huntaway): the kept components read them.
import { Schema } from "effect"

// ---- ids -------------------------------------------------------------------------------------------------------
export const HostId = Schema.String.pipe(Schema.brand("HostId"))
export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"))
export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export const TaskId = Schema.String.pipe(Schema.brand("TaskId")) // also the id of the task's thread
export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export const AgentConfigId = Schema.String.pipe(Schema.brand("AgentConfigId"))
export const PenId = Schema.String.pipe(Schema.brand("PenId"))
export type TaskId = typeof TaskId.Type
export type RunId = typeof RunId.Type

/** RFC 3339, UTC, milliseconds: "2026-11-11T06:16:59.131Z". Compared as strings. */
export const Timestamp = Schema.String.pipe(Schema.brand("Timestamp"))

// ---- enumerations ----------------------------------------------------------------------------------------------
export const Status = Schema.Literals(["backlog", "todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done"])
export const Resolution = Schema.Literals(["done", "not_done", "wont_fix"])
export const TaskKind = Schema.Literals(["task", "review"])
export const TaskType = Schema.Literals(["scratch", "assistant", "routine", "pens", "pen", "summary", "workflow"])
export const DocumentLabel = Schema.Literals(["plan", "artifact", "diagram"])
export const PermissionMode = Schema.Literals(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"])
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export const Agent = Schema.Literals(["claude", "codex"])
export const WorktreeState = Schema.Literals(["none", "setting_up", "ready", "tearing_down", "error"])
export type Status = typeof Status.Type

// ---- values kept on a task -------------------------------------------------------------------------------------
export const StartFrom = Schema.Union([
  Schema.Struct({ type: Schema.Literal("branch"), branch: Schema.String }),
  Schema.Struct({ type: Schema.Literal("task"), task_id: TaskId }),
  Schema.Struct({ type: Schema.Literal("pull_request"), number: Schema.Int, repo: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("commit"), commit: Schema.String })
])

export const ReviewState = Schema.Literals(["running", "passed", "issues", "failed", "stopped"])
export const ReviewerRun = Schema.Struct({
  thread_id: TaskId,
  label: Schema.String,
  state: ReviewState,
  summary: Schema.NullOr(Schema.String),
  issues: Schema.Array(Schema.String),
  verdict: Schema.optional(Schema.String),
  after_run: Schema.optional(RunId)
})
export const Review = Schema.Struct({
  thread_id: TaskId,
  state: ReviewState,
  head: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  issues: Schema.Array(Schema.String),
  verdict: Schema.optional(Schema.String),
  fixes: Schema.Int,
  extra_rounds: Schema.Int,
  updated_at: Timestamp,
  started_at: Schema.optional(Timestamp),
  reviewers: Schema.Array(ReviewerRun)
})

export const Todo = Schema.Struct({ text: Schema.String, status: Schema.Literals(["pending", "in_progress", "completed"]) })
export const Steer = Schema.Struct({ id: Schema.String, text: Schema.String, from_agent: Schema.Boolean, run_id: RunId, written: Schema.Boolean })

// ---- the task --------------------------------------------------------------------------------------------------
// One struct, in the groups the inventory uses. The full field list is docs/plan/inventory/09-data-model.md, 3b.
const Identity = {
  id: TaskId,
  profile_id: ProfileId,
  project_id: Schema.NullOr(ProjectId),
  kind: TaskKind,
  parent_id: Schema.NullOr(TaskId), // a review thread's task; a routine thread's assistant
  task_type: Schema.NullOr(TaskType),
  labels: Schema.Array(DocumentLabel),
  group_name: Schema.NullOr(Schema.String),
  number: Schema.Int,
  key: Schema.String, // new: "HE-2", worked out by the server so no client derives it
  pen_id: Schema.NullOr(PenId),
  fanout_id: Schema.NullOr(Schema.String),
  created_by: Schema.NullOr(TaskId),
  position: Schema.Number
}
const Shown = {
  title: Schema.String,
  title_pinned: Schema.Boolean,
  description: Schema.String,
  status: Status,
  resolution: Schema.NullOr(Resolution),
  done_at: Schema.NullOr(Timestamp),
  attention_reason: Schema.NullOr(Schema.String),
  starred: Schema.Boolean,
  remind_at: Schema.NullOr(Timestamp),
  reminder: Schema.NullOr(Schema.String),
  preview_url: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  todos: Schema.NullOr(Schema.Array(Todo)),
  cost_usd: Schema.Number,
  last_activity_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp
}
const Git = {
  use_worktree: Schema.Boolean,
  worktree_path: Schema.NullOr(Schema.String),
  worktree_state: WorktreeState,
  worktree_error: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  base_branch: Schema.NullOr(Schema.String),
  start_from: Schema.NullOr(StartFrom),
  merges_into: Schema.NullOr(TaskId),
  depends_on: Schema.Array(TaskId),
  merging: Schema.Boolean,
  remerge: Schema.Boolean,
  merge_approval: Schema.NullOr(Schema.Literals(["pending", "approved"])),
  restack: Schema.NullOr(Schema.Literals(["due", "conflict"])),
  waiting: Schema.Boolean
}
const AgentState = {
  session_id: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  run_started_at: Schema.NullOr(Timestamp),
  steerable: Schema.Boolean,
  queued_message: Schema.NullOr(Schema.String), // worked out from the task's queue rows
  steering: Schema.Array(Steer),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  permission_mode: Schema.NullOr(PermissionMode),
  claude_config_id: Schema.NullOr(AgentConfigId),
  limit_reset_at: Schema.NullOr(Timestamp),
  review: Schema.NullOr(Review)
}
export const Task = Schema.Struct({ ...Identity, ...Shown, ...Git, ...AgentState })
export interface Task extends Schema.Schema.Type<typeof Task> {}

/** What `tasks.update` takes: every field optional, and only the ones a client may set. */
export const TaskPatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Status),
  resolution: Schema.optional(Schema.NullOr(Resolution)),
  position: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  effort: Schema.optional(Schema.NullOr(Effort)),
  permission_mode: Schema.optional(Schema.NullOr(PermissionMode)),
  depends_on: Schema.optional(Schema.Array(TaskId)),
  merges_into: Schema.optional(Schema.NullOr(TaskId)),
  starred: Schema.optional(Schema.Boolean),
  todos_override: Schema.optional(Schema.Boolean)
})

// ---- errors that cross the wire --------------------------------------------------------------------------------
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { what: Schema.String, id: Schema.String }) {}
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", { field: Schema.String, reason: Schema.String }) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  reason: Schema.Literals(["agent_running", "worktree_made", "merging", "todos_unfinished", "pr_not_approved", "changed_meanwhile", "has_session", "archived"]),
  detail: Schema.String
}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { scope: Schema.String }) {}

// ---- the thread protocol (threads/protocol.ts in huntaway, as schemas) ----------------------------------------
const ItemBase = {
  id: Schema.String,
  parent_id: Schema.optional(Schema.String),
  created_at: Schema.optional(Timestamp),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
}
export const ToolKind = Schema.Literals(["shell", "read", "edit", "search", "web", "mcp", "app", "subagent", "todo", "other"])
export const ToolStatus = Schema.Literals(["pending", "running", "completed", "failed", "denied", "cancelled"])
export const Item = Schema.Union([
  Schema.Struct({ ...ItemBase, type: Schema.Literal("user_message"), text: Schema.String, steered: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ ...ItemBase, type: Schema.Literal("assistant_message"), text: Schema.String }),
  Schema.Struct({ ...ItemBase, type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    ...ItemBase,
    type: Schema.Literal("tool_call"),
    name: Schema.String,
    kind: ToolKind,
    input: Schema.Unknown,
    status: ToolStatus,
    result: Schema.optional(Schema.Struct({ content: Schema.String, truncated: Schema.optional(Schema.Boolean), exit_code: Schema.optional(Schema.Int) })),
    title: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    server: Schema.optional(Schema.String),
    todos: Schema.optional(Schema.Array(Todo))
  }),
  Schema.Struct({ ...ItemBase, type: Schema.Literal("compaction"), trigger: Schema.optional(Schema.Literals(["auto", "manual"])), summary: Schema.optional(Schema.String) }),
  Schema.Struct({ ...ItemBase, type: Schema.Literal("notice"), level: Schema.Literals(["info", "warning", "error"]), text: Schema.String, code: Schema.optional(Schema.String), detail: Schema.optional(Schema.String) }),
  Schema.Struct({ ...ItemBase, type: Schema.Literal("turn_result"), ok: Schema.Boolean, interrupted: Schema.optional(Schema.Boolean), error: Schema.optional(Schema.String), duration_ms: Schema.optional(Schema.Number) })
])
export type Item = typeof Item.Type

const Seq = { thread_id: TaskId, seq: Schema.Int }
export const ThreadEvent = Schema.Union([
  Schema.Struct({ ...Seq, type: Schema.Literal("item.added"), item: Item }),
  Schema.Struct({ ...Seq, type: Schema.Literal("item.updated"), item_id: Schema.String, patch: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.Struct({ ...Seq, type: Schema.Literal("delta"), item_id: Schema.String, kind: Schema.Literal("text"), offset: Schema.Int, text: Schema.String })
])
export type ThreadEvent = typeof ThreadEvent.Type

// ---- what the board stream carries -----------------------------------------------------------------------------
export const BoardEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), host_id: HostId, boot: Schema.String, seq: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("resync"), seq: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("task"), seq: Schema.Int, task: Task }),
  Schema.Struct({ type: Schema.Literal("task_deleted"), seq: Schema.Int, id: TaskId, project_id: Schema.NullOr(ProjectId) }),
  Schema.Struct({ type: Schema.Literal("profiles_changed"), seq: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("settings_changed"), seq: Schema.Int })
])
export type BoardEvent = typeof BoardEvent.Type

// ---- a JSON column read leniently, as the old readers do ------------------------------------------------------
export const decodeReview = Schema.decodeUnknownOption(Schema.fromJsonString(Review))
export const sample: Task["status"] = "in_review"
