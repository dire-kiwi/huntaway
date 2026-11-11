import { Schema } from "effect"
import { AgentConfig } from "./agentConfig.ts"
import { Approval, ApprovalAction, ApprovalRulesView } from "./approval.ts"
import { HostSettings } from "./host.ts"
import { HostId, ProfileId, ProjectId, RequestId, TaskId } from "./ids.ts"
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
