import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid, NotFound } from "../errors.ts"
import { ProfileId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// A profile's analytics (docs/plan/05-protocol.md, `analytics`; inventory 07, routes 87–90): when the user prompted
// which task and when agents ran (`report`), how big contexts got (`contextStats`), the tokens runs and side calls used
// and what reviews found (`tokenStats`), and what the profile's projects take up on disk (`diskUsage`). Ranges are
// `[from, to)`, RFC 3339 times. Ids are plain strings here: these are reports, read and drawn.

const NullableInt = Schema.NullOr(Schema.Int)
const NullableNumber = Schema.NullOr(Schema.Finite)

/** A range of the profile's history. */
export const AnalyticsRange = { profile_id: ProfileId, from: Schema.String, to: Schema.String }

export const AnalyticsTask = Schema.Struct({
  id: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  kind: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  status: Schema.String,
})
export interface AnalyticsTask extends Schema.Schema.Type<typeof AnalyticsTask> {}

export const AnalyticsProject = Schema.Struct({ id: Schema.String, name: Schema.String, key: Schema.String })
export interface AnalyticsProject extends Schema.Schema.Type<typeof AnalyticsProject> {}

/** A user message on a thread: `prompt` (typed), `start` (the task was started) or `merge` (moved to Ready for merge). */
export const AnalyticsEvent = Schema.Struct({ at: Schema.String, task_id: Schema.String, kind: Schema.String, text: Schema.String })

/** A run: `prompt`, `compact` or `review`; `ended_at` null while it goes. */
export const AnalyticsRun = Schema.Struct({ task_id: Schema.String, kind: Schema.String, started_at: Schema.String, ended_at: Schema.NullOr(Schema.String) })

/** Review threads' activity counts towards the task they review. */
export const AnalyticsReport = Schema.Struct({
  events: Schema.Array(AnalyticsEvent),
  runs: Schema.Array(AnalyticsRun),
  tasks: Schema.Array(AnalyticsTask),
  projects: Schema.Array(AnalyticsProject),
})
export interface AnalyticsReport extends Schema.Schema.Type<typeof AnalyticsReport> {}

/** A turn's end (`turn`) or a compaction (`compact`). */
export const ContextStat = Schema.Struct({
  at: Schema.String,
  task_id: Schema.String,
  kind: Schema.String,
  tokens: NullableInt,
  start_tokens: NullableInt,
  post_tokens: NullableInt,
  max_tokens: NullableInt,
  model: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  cost_usd: NullableNumber,
  duration_ms: NullableInt,
})
export interface ContextStat extends Schema.Schema.Type<typeof ContextStat> {}

export const ContextReport = Schema.Struct({
  stats: Schema.Array(ContextStat),
  tasks: Schema.Array(AnalyticsTask),
  projects: Schema.Array(AnalyticsProject),
})
export interface ContextReport extends Schema.Schema.Type<typeof ContextReport> {}

/** What one run used of one model, or one model call that isn't a run (a title, a window restart). */
export const UsageRow = Schema.Struct({
  run_id: Schema.NullOr(Schema.String),
  call_id: Schema.NullOr(Schema.String),
  task_id: Schema.NullOr(Schema.String),
  kind: Schema.String,
  at: Schema.String,
  model: Schema.String,
  runtime: Schema.String,
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  cache_read_tokens: Schema.Int,
  cache_write_tokens: Schema.Int,
  cache_write_1h_tokens: NullableInt,
  cache_write_5m_tokens: NullableInt,
  reasoning_tokens: Schema.Int,
  cost_usd: NullableNumber,
  estimated: Schema.Boolean,
})
export interface UsageRow extends Schema.Schema.Type<typeof UsageRow> {}

/** What a reviewer reported. */
export const ReviewRow = Schema.Struct({
  task_id: Schema.String,
  thread_id: Schema.String,
  at: Schema.String,
  verdict: Schema.String,
  serious: Schema.Int,
  minor: NullableInt,
  minor_noted: Schema.Boolean,
  label: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  round: Schema.Int,
  effort: Schema.NullOr(Schema.String),
  task_model: Schema.NullOr(Schema.String),
})
export interface ReviewRow extends Schema.Schema.Type<typeof ReviewRow> {}

/** One round of review of a task: its reviewers' submissions together. */
export const RoundRow = Schema.Struct({
  task_id: Schema.String,
  round: Schema.Int,
  at: Schema.String,
  verdict: Schema.String,
  serious: Schema.Int,
  reviewers: Schema.Int,
})
export interface RoundRow extends Schema.Schema.Type<typeof RoundRow> {}

/** A task created by another's agent. */
export const FollowUp = Schema.Struct({ task_id: Schema.String, created_by: Schema.String, at: Schema.String })

export const UsageTask = Schema.Struct({
  ...AnalyticsTask.fields,
  /** A review thread's task. */
  parent_id: Schema.NullOr(Schema.String),
  task_type: Schema.NullOr(Schema.String),
  /** Always false: subprojects are gone (docs/plan/14-dropped-and-open.md); kept for the components that read it. */
  subproject: Schema.Boolean,
  group_name: Schema.NullOr(Schema.String),
  /** The model its own runs used most (by output). */
  model: Schema.NullOr(Schema.String),
})
export interface UsageTask extends Schema.Schema.Type<typeof UsageTask> {}

export const TokenReport = Schema.Struct({
  usage: Schema.Array(UsageRow),
  reviews: Schema.Array(ReviewRow),
  rounds: Schema.Array(RoundRow),
  follow_ups: Schema.Array(FollowUp),
  tasks: Schema.Array(UsageTask),
  projects: Schema.Array(AnalyticsProject),
  /** The profile's runs that have ended but whose tokens aren't counted yet. */
  pending: Schema.Int,
})
export interface TokenReport extends Schema.Schema.Type<typeof TokenReport> {}

/** What a folder takes up on disk (allocated blocks, hard links once). */
export const DiskSize = Schema.Struct({ bytes: Schema.Finite, files: Schema.Int })
export interface DiskSize extends Schema.Schema.Type<typeof DiskSize> {}

/** A worktree; `task_id` null for a stray one (a worktree of the repository no task has). */
export const DiskWorktree = Schema.Struct({
  task_id: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  number: NullableInt,
  title: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  path: Schema.String,
  size: DiskSize,
})
export interface DiskWorktree extends Schema.Schema.Type<typeof DiskWorktree> {}

export const DiskProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  repo_path: Schema.String,
  /** The repository folder (its `.git` included), worktrees and the data folder inside it aside; null when it's gone. */
  repo: Schema.NullOr(DiskSize),
  git: Schema.NullOr(DiskSize),
  /** Biggest first. */
  worktrees: Schema.Array(DiskWorktree),
  /** Its scratch folder and the rest of its folder in the data folder. */
  other: DiskSize,
  /** Its tasks' runs' folders. */
  runs: DiskSize,
})
export interface DiskProject extends Schema.Schema.Type<typeof DiskProject> {}

export const DiskReport = Schema.Struct({
  projects: Schema.Array(DiskProject),
  scratch: DiskSize,
  runs: DiskSize,
  runs_kept_days: Schema.Int,
  /** The host's database (all profiles together). */
  database: NullableNumber,
  backups: Schema.NullOr(DiskSize),
  filesystem: Schema.NullOr(Schema.Struct({ total: Schema.Finite, free: Schema.Finite })),
  elapsed_ms: Schema.Finite,
})
export interface DiskReport extends Schema.Schema.Type<typeof DiskReport> {}

export class AnalyticsRpcs extends RpcGroup.make(
  Rpc.make("analytics.report", { payload: AnalyticsRange, success: AnalyticsReport, error: Schema.Union([Invalid, NotFound]) }).annotate(RequiredScope, "read"),
  Rpc.make("analytics.contextStats", { payload: AnalyticsRange, success: ContextReport, error: Schema.Union([Invalid, NotFound]) }).annotate(
    RequiredScope,
    "read",
  ),
  Rpc.make("analytics.tokenStats", { payload: AnalyticsRange, success: TokenReport, error: Schema.Union([Invalid, NotFound]) }).annotate(RequiredScope, "read"),
  Rpc.make("analytics.diskUsage", { payload: { profile_id: ProfileId }, success: DiskReport, error: NotFound }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
