import { Schema } from "effect"
import { AgentConfigId, PenId, ProfileId, ProjectId, RunId, TaskId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// The task: the central type of the board (docs/plan/03-domain.md, The task), with the values kept on it as JSON. Field
// names are the old API's (huntaway's apps/server/src/wire/tasks.ts). Nested values read from stored JSON keep the old
// optional fields as optional, so a stored value decodes as it is; the task's own fields are always sent.

// ---- enumerations ----------------------------------------------------------------------------------------------

/** The column a task is in. */
export const Status = Schema.Literals(["backlog", "todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done"])
export type Status = typeof Status.Type

/** How a done task ended; set while it is done and only then. */
export const Resolution = Schema.Literals(["done", "not_done", "wont_fix"])
export type Resolution = typeof Resolution.Type

/** `task`, or `review`: a thread under a task (a reviewer, a summarizer, a workflow's agent step), whose `parent_id` is the task. */
export const TaskKind = Schema.Literals(["task", "review"])
export type TaskKind = typeof TaskKind.Type

/**
 * What a thread is, if not a code task or a review. Of a task: `scratch`, `assistant`, `routine`, `pens`, `pen`. Of a
 * review thread: `summary` or `workflow`. See `threadKindOf`.
 */
export const TaskType = Schema.Literals(["scratch", "assistant", "routine", "pens", "pen", "summary", "workflow"])
export type TaskType = typeof TaskType.Type

/** A document a task's agent writes besides its other work: an HTML plan or artifact, or a Mermaid diagram. */
export const DocumentLabel = Schema.Literals(["plan", "artifact", "diagram"])
export type DocumentLabel = typeof DocumentLabel.Type

/** A permission mode, by Claude Code's name for it (the thread protocol spells them in snake_case). */
export const PermissionMode = Schema.Literals(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"])
export type PermissionMode = typeof PermissionMode.Type

/** A thread's effort. `minimal` and `ultra` are Codex models' only; a host's, profile's or reviewer's default is one of the other five. */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export type Effort = typeof Effort.Type

/** The agent CLI that runs a config's threads. */
export const Agent = Schema.Literals(["claude", "codex"])
export type Agent = typeof Agent.Type

export const WorktreeState = Schema.Literals(["none", "setting_up", "ready", "tearing_down", "error"])
export type WorktreeState = typeof WorktreeState.Type

// ---- values kept on a task -------------------------------------------------------------------------------------

/**
 * What a task's worktree starts from instead of the project's base branch: a branch (which becomes its base branch),
 * another task in the project (stacked on its branch), a pull request (`repo` is the `OWNER/REPO` its URL named), or a
 * commit.
 */
export const StartFrom = Schema.Union([
  Schema.Struct({ type: Schema.Literal("branch"), branch: Schema.String }),
  Schema.Struct({ type: Schema.Literal("task"), task_id: TaskId }),
  Schema.Struct({ type: Schema.Literal("pull_request"), number: Schema.Int, repo: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("commit"), commit: Schema.String }),
])
export type StartFrom = typeof StartFrom.Type

/** Commits a task may still carry from a closed or deleted task it was built on, from `commit` back; `key` is that task's. */
export const Carries = Schema.Struct({ key: Schema.NullOr(Schema.String), commit: Schema.NullOr(Schema.String) })
export interface Carries extends Schema.Schema.Type<typeof Carries> {}

/** A task in another tracker that a task is for. Only Asana's. */
export const ExternalLink = Schema.Struct({
  provider: Schema.Literal("asana"),
  /** The task's id there (an Asana gid). */
  id: Schema.String,
  url: Schema.String,
  /** Its name there when it was linked. */
  title: Schema.String,
})
export interface ExternalLink extends Schema.Schema.Type<typeof ExternalLink> {}

export const FailedCheck = Schema.Struct({
  /** `Workflow / job` for GitHub Actions, the check's or status's name otherwise. */
  name: Schema.String,
  /** `failure`, `cancelled`, `timed_out`… */
  conclusion: Schema.String,
  url: Schema.NullOr(Schema.String),
})
export interface FailedCheck extends Schema.Schema.Type<typeof FailedCheck> {}

/** How a task's pull request's checks stood on its head commit when the board last read them. */
export const PrChecks = Schema.Struct({
  /** The pull request read; the task's `pr_url` may have changed since. */
  url: Schema.String,
  head: Schema.String,
  outcome: Schema.Literals(["failed", "passed", "pending", "none"]),
  failed: Schema.Array(FailedCheck),
  /** How many more failed than are listed. */
  more_failed: Schema.Int,
  pending: Schema.Int,
  passed: Schema.Int,
  /** When a read first found them like this. */
  since: Timestamp,
})
export interface PrChecks extends Schema.Schema.Type<typeof PrChecks> {}

/** How much of a thread's context window its agent's session uses, as of its latest reply. */
export const Context = Schema.Struct({
  tokens: Schema.Int,
  max_tokens: Schema.NullOr(Schema.Int),
  /** Where Claude Code compacts the session by itself, if it does. */
  compact_at: Schema.NullOr(Schema.Int),
  model: Schema.NullOr(Schema.String),
  updated_at: Timestamp,
  /** When the breakdown of what is in it was taken, if there is one. */
  detail_at: Schema.NullOr(Timestamp),
})
export interface Context extends Schema.Schema.Type<typeof Context> {}

/** An item of a task's todo list: its agent's latest TodoWrite (Claude) or plan (Codex). */
export const Todo = Schema.Struct({ text: Schema.String, status: Schema.Literals(["pending", "in_progress", "completed"]) })
export interface Todo extends Schema.Schema.Type<typeof Todo> {}

/** Something an assistant is doing or following for the user (its `track_work` tool). */
export const TrackedItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  status: Schema.Literals(["working", "waiting_user", "waiting_task", "done", "failed"]),
  /** The board task it follows (on this host or a linked one), as `get_task` named it when it was linked. */
  task_id: Schema.NullOr(TaskId),
  task_key: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export interface TrackedItem extends Schema.Schema.Type<typeof TrackedItem> {}

/** A task a wait watches, with the status it had. */
export const WaitTask = Schema.Struct({
  id: TaskId,
  key: Schema.String,
  status: Status,
  /** Its review's `updated_at` as the wait started (null: it had none); its review finishing after that ends the wait too. */
  review_at: Schema.optional(Schema.NullOr(Timestamp)),
})
export interface WaitTask extends Schema.Schema.Type<typeof WaitTask> {}

/** The pull request a wait watches. */
export const WaitPr = Schema.Struct({
  url: Schema.String,
  /** `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com. */
  repo: Schema.String,
  number: Schema.Int,
  /** What ends the wait besides its being merged or closed. */
  events: Schema.Array(Schema.Literals(["checks_failed", "checks_passed", "comments", "conflicts"])),
  /** What a read found that ends the wait, kept until the call returns. */
  news: Schema.optional(Schema.Unknown),
})
export interface WaitPr extends Schema.Schema.Type<typeof WaitPr> {}

/** What an agent in the `wait` tool is waiting for. Not to be confused with `Task.waiting`. */
export const AgentWait = Schema.Struct({
  /** In the agent's words. */
  reason: Schema.NullOr(Schema.String),
  since: Timestamp,
  /** When the wait ends at the latest. */
  until: Timestamp,
  /** Tasks whose next change of status ends the wait. */
  tasks: Schema.Array(WaitTask),
  /** A shell command whose exit ends the wait. */
  command: Schema.optional(Schema.String),
  /** The tool call that is waiting, and its run. */
  call_id: Schema.String,
  run_id: RunId,
  /** Set as the task is moved to this column, which ends the wait. */
  moved_to: Schema.optional(Status),
  /** The first subagent that finished during the wait, kept until the call returns. */
  subagent_finished: Schema.optional(Schema.Unknown),
  pull_request: Schema.optional(WaitPr),
})
export interface AgentWait extends Schema.Schema.Type<typeof AgentWait> {}

/** One of the running agent's background tasks, as Claude Code lists them. */
export const BackgroundItem = Schema.Struct({
  /** Claude Code's id for it. */
  id: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["shell", "subagent", "other"]),
  description: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Timestamp),
  /** A shell the agent said it waits on: it keeps the task working. */
  waited: Schema.Boolean,
})
export interface BackgroundItem extends Schema.Schema.Type<typeof BackgroundItem> {}

/** What the running agent has going in the background. */
export const BackgroundWork = Schema.Struct({
  run_id: RunId,
  /** Its turn has ended and only shells it does not wait on are left: shown idle, not working. */
  idle: Schema.Boolean,
  tasks: Schema.Array(BackgroundItem),
})
export interface BackgroundWork extends Schema.Schema.Type<typeof BackgroundWork> {}

/** A TCP port one of the task's processes listens on. */
export const TaskServer = Schema.Struct({
  port: Schema.Int,
  /** `127.0.0.1`, `::1`, `0.0.0.0` or `::`. */
  address: Schema.String,
  /** The listening process and its process group, which Stop signals. */
  pid: Schema.Int,
  pgid: Schema.Int,
  /** Its command line, shortened. */
  command: Schema.String,
  since: Timestamp,
  /** It outlives the run that started it. */
  detached: Schema.Boolean,
})
export interface TaskServer extends Schema.Schema.Type<typeof TaskServer> {}

/** A message sent to a running agent, kept until the agent takes it in. */
export const Steer = Schema.Struct({
  /** Also the stream-json message's uuid, which the agent echoes back when it takes it in. */
  id: Schema.String,
  text: Schema.String,
  from_agent: Schema.Boolean,
  run_id: RunId,
  /** Written to the run's input; until then it waits for the run to start. */
  written: Schema.Boolean,
  /** The automation runs whose messages it carries. */
  routine_runs: Schema.optional(Schema.Array(Schema.String)),
  routine: Schema.optional(Schema.Boolean),
})
export interface Steer extends Schema.Schema.Type<typeof Steer> {}

export const ReviewState = Schema.Literals(["running", "passed", "issues", "failed", "stopped"])
export type ReviewState = typeof ReviewState.Type

/** One reviewer's part of a review. */
export const ReviewerRun = Schema.Struct({
  thread_id: TaskId,
  /** Which agent reviews, e.g. "Codex · gpt-5.1". */
  label: Schema.String,
  state: ReviewState,
  summary: Schema.NullOr(Schema.String),
  issues: Schema.Array(Schema.String),
  /** Set by `submit_review` while it runs: pass or issues. */
  verdict: Schema.optional(Schema.String),
  /** The thread's last run before this round (empty if none): only a later run's end or verdict counts. */
  after_run: Schema.optional(RunId),
})
export interface ReviewerRun extends Schema.Schema.Type<typeof ReviewerRun> {}

/** A task's latest automatic review; with several reviewers, `reviewers` has each one's part and the rest combines them. */
export const Review = Schema.Struct({
  /** The (first) review thread. */
  thread_id: TaskId,
  state: ReviewState,
  /** The commit reviewed. */
  head: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  /** Serious issues, which go back to the task's agent to fix. */
  issues: Schema.Array(Schema.String),
  verdict: Schema.optional(Schema.String),
  /** Reviews in a row that sent issues back (capped by the project's review_rounds plus `extra_rounds`). */
  fixes: Schema.Int,
  extra_rounds: Schema.Int,
  updated_at: Timestamp,
  /** When this round started. */
  started_at: Schema.optional(Timestamp),
  reviewers: Schema.Array(ReviewerRun),
})
export interface Review extends Schema.Schema.Type<typeof Review> {}

export const SummaryState = Schema.Literals(["running", "done", "failed", "stopped"])
export type SummaryState = typeof SummaryState.Type

/** A summary of a task's changes, written once its review passed. */
export const ChangeSummary = Schema.Struct({
  /** The summary thread (kind `review`, type `summary`). */
  thread_id: TaskId,
  /** Who writes it, e.g. "Claude · haiku". */
  label: Schema.String,
  /** Its summarizer's name, when it has one. */
  name: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(Schema.String)),
  /** Its summarizer had a prompt of its own. */
  custom_prompt: Schema.optional(Schema.Boolean),
  state: SummaryState,
  /** The commit summarised. */
  head: Schema.NullOr(Schema.String),
  /** The summary (Markdown), or why there is none. */
  text: Schema.NullOr(Schema.String),
  after_run: Schema.optional(RunId),
  updated_at: Timestamp,
})
export interface ChangeSummary extends Schema.Schema.Type<typeof ChangeSummary> {}

/** The conversation rollback a task's next run makes, after a rewind. */
export const Rewind = Schema.Struct({
  turn: Schema.Int,
  message_id: Schema.Int,
  session: Schema.String,
  resume_at: Schema.optional(Schema.String),
  before_turn: Schema.optional(Schema.String),
})
export interface Rewind extends Schema.Schema.Type<typeof Rewind> {}

// ---- the task --------------------------------------------------------------------------------------------------

export const Task = Schema.Struct({
  // identity and placement
  id: TaskId,
  profile_id: ProfileId,
  project_id: Schema.NullOr(ProjectId),
  kind: TaskKind,
  /** A review thread's task; a routine thread's assistant. */
  parent_id: Schema.NullOr(TaskId),
  task_type: Schema.NullOr(TaskType),
  labels: Schema.Array(DocumentLabel),
  /** A group task: the group whose projects it plans. */
  group_name: Schema.NullOr(Schema.String),
  /** The `n` of its key; 0 for review threads. */
  number: Schema.Int,
  /** "HE-2": worked out by the server (`keyLetter`), so no client derives it. */
  key: Schema.String,
  pen_id: Schema.NullOr(PenId),
  /** Shared by the tasks made together from one prompt, each run by another agent. */
  fanout_id: Schema.NullOr(Schema.String),
  /** The task whose agent created this one. */
  created_by: Schema.NullOr(TaskId),
  /** Order within (project, status, kind). */
  position: Schema.Finite,
  /** Where its agent works when not where its kind and project say: absolute, or relative to the data folder. */
  work_dir: Schema.NullOr(Schema.String),

  // what the user sees
  title: Schema.String,
  /** Renamed by hand, so a user's prompt does not re-title it. */
  title_pinned: Schema.Boolean,
  description: Schema.String,
  status: Status,
  resolution: Schema.NullOr(Resolution),
  /** When it moved into Done; set while it is done. Done for two days is archived (worked out by clients). */
  done_at: Schema.NullOr(Timestamp),
  attention_reason: Schema.NullOr(Schema.String),
  starred: Schema.Boolean,
  remind_at: Schema.NullOr(Timestamp),
  reminder: Schema.NullOr(Schema.String),
  preview_url: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  pr_checks: Schema.NullOr(PrChecks),
  external_links: Schema.Array(ExternalLink),
  /** Its agent's todo list as its latest update left it; empty if it has none. */
  todos: Schema.Array(Todo),
  /** An assistant's tracked work; empty for other tasks. */
  tracked: Schema.Array(TrackedItem),
  context: Schema.NullOr(Context),
  /** When one of its documents last changed. */
  document_at: Schema.NullOr(Timestamp),
  cost_usd: Schema.Finite,
  last_activity_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,

  // git and merging
  use_worktree: Schema.Boolean,
  worktree_path: Schema.NullOr(Schema.String),
  worktree_state: WorktreeState,
  worktree_error: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  base_branch: Schema.NullOr(Schema.String),
  start_from: Schema.NullOr(StartFrom),
  /** The task in the same project whose branch this one merges into. Kept once done and when the target is deleted. */
  merges_into: Schema.NullOr(TaskId),
  carries: Schema.NullOr(Carries),
  /** A stack level's restack: `due` once the task below is merged, `conflict` when its agent has to do it. */
  restack: Schema.NullOr(Schema.Literals(["due", "conflict"])),
  /** The GitHub stack number its pull request is in. */
  github_stack: Schema.NullOr(Schema.Int),
  /** A stack's title and description, on the stack's bottom task only. */
  stack_title: Schema.NullOr(Schema.String),
  stack_description: Schema.NullOr(Schema.String),
  stack_pinned: Schema.Boolean,
  /** The whole-stack merge run this level is in. */
  stack_run: Schema.NullOr(Schema.String),
  /** Moved to Ready for merge and not merged yet. */
  merging: Schema.Boolean,
  /** Stepped out of the merge queue to fix something; rejoins it when its run ends. */
  remerge: Schema.Boolean,
  merge_approval: Schema.NullOr(Schema.Literals(["pending", "approved"])),
  /** Tasks in the same project that have to be merged before its agent starts. */
  depends_on: Schema.Array(TaskId),
  /** Queued in In progress for its dependencies or a usage limit's reset. */
  waiting: Schema.Boolean,

  // the agent and its run
  session_id: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  run_started_at: Schema.NullOr(Timestamp),
  /** Its run takes messages while it works, rather than queueing them. */
  steerable: Schema.Boolean,
  /** When the usage limit its agent last ran out of resets. */
  limit_reset_at: Schema.NullOr(Timestamp),
  agent_wait: Schema.NullOr(AgentWait),
  background_work: Schema.NullOr(BackgroundWork),
  /** The ports its processes listen on (Linux only); empty if none. */
  servers: Schema.Array(TaskServer),
  /** Worked out from the task's queue rows: the next prompt once the run ends. */
  queued_message: Schema.NullOr(Schema.String),
  /** Worked out from the task's steer rows: sent to the running agent and not taken in yet. */
  steering: Schema.Array(Steer),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  /** null inherits the project's, then the host's. */
  permission_mode: Schema.NullOr(PermissionMode),
  /** The agent config it runs with, picked when it is created; null (or deleted since) means its project's or profile's default. */
  claude_config_id: Schema.NullOr(AgentConfigId),
  /** Tool rules always allowed for it. */
  auto_allow: Schema.Array(Schema.String),
  review: Schema.NullOr(Review),
  /** One from each summarizer; possibly empty. */
  summaries: Schema.Array(ChangeSummary),
  rewind: Schema.NullOr(Rewind),
})
export interface Task extends Schema.Schema.Type<typeof Task> {}

// ---- requests --------------------------------------------------------------------------------------------------

/**
 * Where a worktree starts, as a request gives it: a `StartFrom`, or text (`task:KEY-N`, `branch:name`, `pr:12`, `#12`, a
 * pull request's URL, `commit:<sha>`, or bare, tried as a task, a pull request, a commit and then a branch). Blank or
 * null is the project's base branch.
 */
export const StartFromInput = Schema.Union([Schema.String, StartFrom])
export type StartFromInput = typeof StartFromInput.Type

/**
 * What `tasks.update` takes (the old `PATCH /tasks/{id}`): only what a client may set, each optional. Times are RFC 3339
 * in any offset; the server stores them in UTC.
 */
export const TaskPatch = Schema.Struct({
  /** Not blank. Changing it pins the title unless `title_pinned` is given. */
  title: Schema.optional(Schema.String),
  title_pinned: Schema.optional(Schema.Boolean),
  /** null is "". */
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Status),
  /** Checked against the status the task ends up in. */
  resolution: Schema.optional(Schema.NullOr(Resolution)),
  position: Schema.optional(Schema.Finite),
  /** A worktree setting: refused once the worktree is made. */
  use_worktree: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  effort: Schema.optional(Schema.NullOr(Effort)),
  /** A worktree setting; a non-null one clears `start_from`. */
  base_branch: Schema.optional(Schema.NullOr(Schema.String)),
  /** A worktree setting; one clears `base_branch`. */
  start_from: Schema.optional(Schema.NullOr(StartFromInput)),
  permission_mode: Schema.optional(Schema.NullOr(PermissionMode)),
  /** null or blank clears it; otherwise an http(s) URL. */
  preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  pr_url: Schema.optional(Schema.NullOr(Schema.String)),
  /** At most 20; null is none. */
  external_links: Schema.optional(Schema.NullOr(Schema.Array(ExternalLink))),
  /** Only before its agent has a session, and one of the configs its project or profile offers. */
  claude_config_id: Schema.optional(AgentConfigId),
  depends_on: Schema.optional(Schema.Array(TaskId)),
  starred: Schema.optional(Schema.Boolean),
  /** null or blank clears it, and the reminder with it. */
  remind_at: Schema.optional(Schema.NullOr(Schema.String)),
  /** At most 500 characters; needs a time. */
  reminder: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only on a done task: when it was done, which un-archives it. */
  done_at: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(DocumentLabel)),
  /** A task's id or key in the same project; null or blank merges into the project's base branch. */
  merges_into: Schema.optional(Schema.NullOr(Schema.String)),
  /** Into a pen by its name (made if the profile has none by it); null or blank takes it out. */
  pen: Schema.optional(Schema.NullOr(Schema.String)),
  /** Into a pen by its id; null takes it out. */
  pen_id: Schema.optional(Schema.NullOr(PenId)),
  /** Move it out of In progress though its agent's todo list is unfinished ("Move anyway"). */
  todos_override: Schema.optional(Schema.Boolean),
  /** With `status: "in_progress"` while its agent is merging it: step out of the merge queue and rejoin it when the run ends. */
  remerge: Schema.optional(Schema.Boolean),
})
export interface TaskPatch extends Schema.Schema.Type<typeof TaskPatch> {}

/**
 * What `tasks.create` takes. Which task it makes:
 * - `project_id`: a task in that project (the old `POST /projects/{id}/tasks`); `task_type: "scratch"` makes a scratch
 *   task that reads the project's repository.
 * - `profile_id` and `group`: a group task, planning across the profile's projects in that group (the old
 *   `POST /profiles/{id}/group-tasks`). No worktree, no dependencies.
 * - `profile_id` alone: a scratch task in no project (the old `POST /profiles/{id}/tasks`). No worktree, no dependencies.
 * A title or a description is needed; with only a description the task gets a placeholder title and a generated one
 * shortly.
 */
export const NewTask = Schema.Struct({
  project_id: Schema.optional(ProjectId),
  profile_id: Schema.optional(ProfileId),
  group: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Default `todo`. */
  status: Schema.optional(Status),
  /** Only with status `done`. */
  resolution: Schema.optional(Schema.NullOr(Resolution)),
  /** Unset: the project's `use_worktrees` when its folder is a git repository. */
  use_worktree: Schema.optional(Schema.NullOr(Schema.Boolean)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  effort: Schema.optional(Schema.NullOr(Effort)),
  /** Start its agent now: `true`, or text sent as an extra prompt. */
  start: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  /** One of the configs its project or profile offers; unset is the first of them. */
  claude_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  depends_on: Schema.optional(Schema.Array(TaskId)),
  task_type: Schema.optional(Schema.NullOr(Schema.Literal("scratch"))),
  labels: Schema.optional(Schema.Array(DocumentLabel)),
  external_links: Schema.optional(Schema.Array(ExternalLink)),
  /** Up to 64 of `[A-Za-z0-9_-]`; blank is none. */
  fanout_id: Schema.optional(Schema.NullOr(Schema.String)),
  start_from: Schema.optional(Schema.NullOr(StartFromInput)),
  /** A task's id or key in the project; it also starts from that task's branch unless `start_from` is given. */
  merges_into: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface NewTask extends Schema.Schema.Type<typeof NewTask> {}

/**
 * Which tasks `tasks.list` returns. Review threads are never listed unless `kind: "review"` asks for a project's.
 * - `ByProject`: a project's tasks (or its review threads), in board order.
 * - `ByProfile`: a profile's tasks in every project and none, without its assistant, routine, pens and pen threads
 *   unless `include_assistant` asks for the assistant.
 * - `Projectless`: a profile's tasks in no project (group and scratch tasks), with the assistant, the pens thread and
 *   the pens' own threads when asked for.
 */
export const TaskFilter = Schema.Union([
  Schema.TaggedStruct("ByProject", { project_id: ProjectId, kind: Schema.optional(TaskKind) }),
  Schema.TaggedStruct("ByProfile", { profile_id: ProfileId, include_assistant: Schema.optional(Schema.Boolean) }),
  Schema.TaggedStruct("Projectless", {
    profile_id: ProfileId,
    include_assistant: Schema.optional(Schema.Boolean),
    include_pens: Schema.optional(Schema.Boolean),
    include_pen_threads: Schema.optional(Schema.Boolean),
  }),
])
export type TaskFilter = typeof TaskFilter.Type
