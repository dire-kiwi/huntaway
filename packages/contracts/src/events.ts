import { Schema } from "effect"
import { AgentConfig } from "./agentConfig.ts"
import { Approval, ApprovalAction, ApprovalRulesView } from "./approval.ts"
import { HostSettings } from "./host.ts"
import { AutomationId, HostId, ProfileId, ProjectId, RequestId, TaskId, WorkflowId } from "./ids.ts"
import { Pen } from "./pen.ts"
import { Profile } from "./profile.ts"
import { Project } from "./project.ts"
import { Task } from "./task.ts"
import { ReleaseDownload, RestartPhase } from "./update.ts"
import { Usage } from "./usage.ts"

// What a host's board stream carries (docs/plan/03-domain.md, Events): the old `HostEvent` union with a sequence
// number on every event, minus the legacy kinds. The components switch on `type`. A new kind is added here first.
// Where the old event said "read them again", the new one carries what to read, so a client never loads lists beside
// the stream.

const seq = { seq: Schema.Int }

/** First on every subscription: which host, which boot of it, and the sequence number the stream continues from. */
export const Hello = Schema.Struct({ type: Schema.Literal("hello"), host_id: HostId, boot: Schema.String, ...seq })
/** Events were dropped or cannot be replayed: subscribe again without `since`. The stream ends after it. */
export const Resync = Schema.Struct({ type: Schema.Literal("resync"), ...seq })
/** A task was made or changed: all of it. */
export const TaskChanged = Schema.Struct({ type: Schema.Literal("task"), task: Task, ...seq })
/** A task is gone. `project_id` is null for a task in no project. */
export const TaskDeleted = Schema.Struct({ type: Schema.Literal("task_deleted"), id: TaskId, project_id: Schema.NullOr(ProjectId), ...seq })
/** A project was made or changed (archived or not): all of it. */
export const ProjectChanged = Schema.Struct({ type: Schema.Literal("project"), project: Project, ...seq })
export const ProjectDeleted = Schema.Struct({ type: Schema.Literal("project_deleted"), id: ProjectId, ...seq })
/** A profile or an agent config was made, changed or removed: all of them. */
export const ProfilesChanged = Schema.Struct({
  type: Schema.Literal("profiles_changed"),
  profiles: Schema.Array(Profile),
  configs: Schema.Array(AgentConfig),
  ...seq,
})
/** The host's settings changed: all of them. */
export const SettingsChanged = Schema.Struct({ type: Schema.Literal("settings_changed"), settings: HostSettings, ...seq })
/** A profile's pens changed: all of them. */
export const PensChanged = Schema.Struct({ type: Schema.Literal("pens"), profile_id: ProfileId, pens: Schema.Array(Pen), ...seq })
/** An agent config's usage changed: all of it. */
export const UsageChanged = Schema.Struct({ type: Schema.Literal("usage"), usage: Usage, ...seq })
/** A profile's approval rules were saved or reset: all of them, as `approvalRules.get` gives them. */
export const ApprovalRulesChanged = Schema.Struct({ type: Schema.Literal("approval_rules"), profile_id: ProfileId, rules: ApprovalRulesView, ...seq })
/** A call went in a profile's action log, or its entry was settled: the entry as it is now. */
export const ApprovalLogChanged = Schema.Struct({
  type: Schema.Literal("approval_log"),
  profile_id: ProfileId,
  task_id: TaskId,
  action: ApprovalAction,
  ...seq,
})
/**
 * One of the board's own approvals (a project change, a task's deletion, an automation or a workflow) was asked
 * (`approval`), or is no longer waiting (`approval` null: answered, expired, or its thread gone).
 */
export const ApprovalChanged = Schema.Struct({ type: Schema.Literal("approval"), request_id: RequestId, approval: Schema.NullOr(Approval), ...seq })

/** This host's restart job moved to another phase (or failed, with why). */
export const RestartChanged = Schema.Struct({ type: Schema.Literal("restart"), phase: RestartPhase, error: Schema.NullOr(Schema.String), ...seq })
/** A line of the restart job's log (a build's output, a download's progress). */
export const RestartLog = Schema.Struct({ type: Schema.Literal("restart_log"), line: Schema.String, ...seq })
/** A release check finished: `admin.status` has what it found. */
export const ReleaseChecked = Schema.Struct({ type: Schema.Literal("release_checked"), ...seq })
/** The background download of a release moved on; null once it is staged. */
export const ReleaseDownloadChanged = Schema.Struct({ type: Schema.Literal("release_download"), download: Schema.NullOr(ReleaseDownload), ...seq })
/** A task's checkpoints changed (a turn's was taken, or it was rewound): its turns are read again (`checkpoints.turns`). */
export const CheckpointsChanged = Schema.Struct({ type: Schema.Literal("checkpoints"), task_id: TaskId, ...seq })

// 6.8: what push notifies of besides tasks, emitted by the areas that know (both are above push).
/**
 * A profile's assistant finished a reply (its turn's result; not a compaction's): emitted by `Assistant` (6.7) at the
 * end of a turn, for push's `replies` (the old `assistant_reply`, which Telegram emitted).
 */
export const AssistantReplied = Schema.Struct({ type: Schema.Literal("assistant_reply"), task_id: TaskId, profile_id: ProfileId, ...seq })
/**
 * A routine posted its report on the assistant's thread (once per run): emitted by `Routines` (6.5) as it posts it, for
 * push's `reports` (the old `report` thread message). `task_id` is the routine's thread (else the assistant's), which
 * the notification opens; `text` is the report's.
 */
export const RoutineReported = Schema.Struct({
  type: Schema.Literal("routine_report"),
  /** The report message's id, for the notification's tag. */
  id: Schema.String,
  task_id: TaskId,
  automation: Schema.String,
  outcome: Schema.Literals(["reported", "failed", "asked"]),
  text: Schema.String,
  ...seq,
})
/**
 * 6.5: an automation (or routine) was made, changed or deleted, or a run or delivery of it was recorded or its cost
 * changed: its owner's list and its runs are read again. `project_id` is null for a profile's routine.
 */
export const AutomationsChanged = Schema.Struct({
  type: Schema.Literal("automations_changed"),
  project_id: Schema.NullOr(ProjectId),
  profile_id: ProfileId,
  automation_id: AutomationId,
  ...seq,
})
/** 6.3: a profile's document was published, moved, relabelled or (`deleted`) deleted: it is read again. */
export const DocsChanged = Schema.Struct({
  type: Schema.Literal("docs"),
  profile_id: ProfileId,
  slug: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  ...seq,
})
/** 6.3: a document's comments changed (added, edited, deleted or sent): they are read again. */
export const DocCommentsChanged = Schema.Struct({ type: Schema.Literal("doc_comments"), profile_id: ProfileId, slug: Schema.String, ...seq })
/** 6.3: a profile's connection to its docs site changed (a sign-in started, stopped, connected or was forgotten). */
export const DocsSiteChanged = Schema.Struct({ type: Schema.Literal("docs_site"), profile_id: ProfileId, ...seq })
/** 6.6: a project's workflow was made, changed or deleted: its workflows are read again (`workflows.list`). */
export const WorkflowsChanged = Schema.Struct({ type: Schema.Literal("workflows_changed"), project_id: ProjectId, workflow_id: WorkflowId, ...seq })
/** 6.6: a task's workflow runs changed: they are read again (`workflows.runsOfTask`). */
export const WorkflowRunsChanged = Schema.Struct({ type: Schema.Literal("workflow_runs_changed"), task_id: TaskId, ...seq })

export const BoardEvent = Schema.Union([
  Hello,
  Resync,
  TaskChanged,
  TaskDeleted,
  ProjectChanged,
  ProjectDeleted,
  ProfilesChanged,
  SettingsChanged,
  PensChanged,
  UsageChanged,
  ApprovalRulesChanged,
  ApprovalLogChanged,
  ApprovalChanged,
  RestartChanged,
  RestartLog,
  ReleaseChecked,
  ReleaseDownloadChanged,
  CheckpointsChanged,
  // 6.8
  AssistantReplied,
  RoutineReported,
  // 6.5
  AutomationsChanged,
  // 6.3: documents.
  DocsChanged,
  DocCommentsChanged,
  DocsSiteChanged,
  // 6.6
  WorkflowsChanged,
  WorkflowRunsChanged,
])
export type BoardEvent = typeof BoardEvent.Type

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as a service emits it: `Events` numbers it. `hello` and `resync` are the stream's own. */
export type BoardEventInput = DistributiveOmit<Exclude<BoardEvent, { readonly type: "hello" | "resync" }>, "seq">

/**
 * The second message of `board.watch` when it cannot replay: everything the board holds for this host, read in one
 * transaction at `seq`. Every event after it follows.
 */
export const BoardSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  seq: Schema.Int,
  profiles: Schema.Array(Profile),
  configs: Schema.Array(AgentConfig),
  projects: Schema.Array(Project),
  archived_projects: Schema.Array(Project),
  tasks: Schema.Array(Task),
  pens: Schema.Array(Pen),
  settings: HostSettings,
  usage: Schema.Array(Usage),
  /** The board's own approvals waiting for the user, oldest first. */
  approvals: Schema.Array(Approval),
})
export interface BoardSnapshot extends Schema.Schema.Type<typeof BoardSnapshot> {}

/** A message of `board.watch`. */
export const BoardMessage = Schema.Union([BoardSnapshot, BoardEvent])
export type BoardMessage = typeof BoardMessage.Type
