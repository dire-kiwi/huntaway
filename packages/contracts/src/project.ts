import { Schema } from "effect"
import { AgentConfigId, ProfileId, ProjectId, TaskId } from "./ids.ts"
import { PermissionMode, Status } from "./task.ts"
import { Timestamp } from "./time.ts"

// A project (huntaway's apps/server/src/wire/projects.ts), without `subproject_pull_requests` (subprojects are gone) and
// `summarizer` (the first of `summarizers`, for old clients).

/** Which news of an In review task's pull request wakes its agent: none, failed checks and conflicts, or comments and reviews too. */
export const WatchPullRequests = Schema.Literals(["off", "failures", "all"])
export type WatchPullRequests = typeof WatchPullRequests.Type

/**
 * A reviewer or a summarizer of a project's or a profile's tasks: the agent that works in a thread of its own under the
 * task. Kept as JSON, so the optional fields stay left out when unset, as stored.
 */
export const Reviewer = Schema.Struct({
  /** null uses the task's config. */
  claude_config_id: Schema.NullOr(AgentConfigId),
  /** null uses the default (the project's, profile's or host's). */
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  /** A summarizer's name where its summary is shown. */
  name: Schema.optional(Schema.String),
  /** Skills its agent uses, named in its prompt. */
  skills: Schema.optional(Schema.Array(Schema.String)),
  /** Replaces the board's instructions (a summarizer) or the project's In review prompt (a reviewer). */
  prompt: Schema.optional(Schema.String),
})
export interface Reviewer extends Schema.Schema.Type<typeof Reviewer> {}

/** A script per status, run when one of the project's tasks moves into it. */
export const StatusScripts = Schema.Record(Status, Schema.optional(Schema.String))
export type StatusScripts = typeof StatusScripts.Type

export const Project = Schema.Struct({
  id: ProjectId,
  profile_id: ProfileId,
  name: Schema.String,
  key: Schema.String,
  /** Keys it had before, newest last, so old task keys (`OS-2` after `OS` became `OMS`) still name its tasks. */
  former_keys: Schema.Array(Schema.String),
  repo_path: Schema.String,
  scratch_path: Schema.String,
  worktrees_root: Schema.String,
  base_branch: Schema.NullOr(Schema.String),
  setup_script: Schema.String,
  teardown_script: Schema.String,
  /** Ignored files copied into each new worktree, .gitignore-style, one per line. */
  copy_files: Schema.String,
  /** Ignored folders linked into each new worktree, one per line. */
  link_folders: Schema.String,
  /** Runs whenever one of its tasks changes status. */
  status_script: Schema.String,
  status_scripts: StatusScripts,
  /** Whether new tasks get a worktree; applies once the folder is a git repository with a commit. */
  use_worktrees: Schema.Boolean,
  /** Cached: the folder is a git repository. */
  is_git: Schema.Boolean,
  /** Cached: it has a commit checked out, which a worktree branches from. */
  has_commits: Schema.Boolean,
  /** The thread that helps the user get the folder ready for worktrees. */
  setup_task_id: Schema.NullOr(TaskId),
  /** null uses the host's default. */
  permission_mode: Schema.NullOr(PermissionMode),
  model: Schema.NullOr(Schema.String),
  /** Overrides the profile's configs when set. */
  claude_config_ids: Schema.NullOr(Schema.Array(AgentConfigId)),
  /** Review each task's work when it moves to In review (not with `use_workflows`). */
  auto_review: Schema.Boolean,
  /** Move a task in In review or Needs attention to Done when its pull request is merged on GitHub. */
  done_when_merged: Schema.Boolean,
  /** Its workflows take its tasks across the board instead of the board's own reviews and summaries. */
  use_workflows: Schema.Boolean,
  /** Agents open a pull request when the repository is on GitHub. */
  pull_requests: Schema.Boolean,
  /** Review rounds in a row whose issues go back to the agent before the task is left for the user. */
  review_rounds: Schema.Int,
  /** Empty uses the profile's. */
  reviewers: Schema.Array(Reviewer),
  auto_summary: Schema.Boolean,
  /** Empty uses the profile's. */
  summarizers: Schema.Array(Reviewer),
  /** Merges wait for the user's approval of a summary; null follows the profile. */
  merge_approval: Schema.NullOr(Schema.Boolean),
  /** Ready for merge needs an approving review on GitHub; null follows the profile. */
  require_pr_approval: Schema.NullOr(Schema.Boolean),
  /** Its instructions for an agent's start, review and merge prompts; null uses the host's. */
  start_prompt: Schema.NullOr(Schema.String),
  review_prompt: Schema.NullOr(Schema.String),
  merge_prompt: Schema.NullOr(Schema.String),
  /** The sidebar group it is in, which has a board of all its projects' tasks. */
  group_name: Schema.NullOr(Schema.String),
  /** Archived: off the board, agents do not start, merges and waits freeze. */
  archived_at: Schema.NullOr(Timestamp),
  /** Overrides the profile's GitHub account. */
  github_account: Schema.NullOr(Schema.String),
  watch_pull_requests: WatchPullRequests,
  /** A pull request's preview, with `{pr}` for its number: a task gets it as its `preview_url`. */
  pr_preview_url: Schema.NullOr(Schema.String),
  created_at: Timestamp,
})
export interface Project extends Schema.Schema.Type<typeof Project> {}

/** What `projects.create` takes (the old `POST /profiles/{id}/projects`). */
export const NewProject = Schema.Struct({
  profile_id: ProfileId,
  /** Blank: the folder's name. */
  name: Schema.optional(Schema.String),
  /** May start with `~`. A folder that does not exist is made, if the path is absolute. */
  repo_path: Schema.String,
  /** 1 to 10 letters or digits, not `G`, `S` or `A`; unset is derived from the name. */
  key: Schema.optional(Schema.NullOr(Schema.String)),
  /** Unset: the branch checked out. */
  base_branch: Schema.optional(Schema.NullOr(Schema.String)),
  use_worktrees: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
export interface NewProject extends Schema.Schema.Type<typeof NewProject> {}

/** What `projects.update` takes (the old `PATCH /projects/{id}`): each field optional; null or blank text is unset. */
export const ProjectPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  /** The old key is kept in `former_keys`. */
  key: Schema.optional(Schema.String),
  /** Where the folder is now; with `move_repo`, where to move it. */
  repo_path: Schema.optional(Schema.String),
  /** With `repo_path`: move the folder there. */
  move_repo: Schema.optional(Schema.Boolean),
  base_branch: Schema.optional(Schema.NullOr(Schema.String)),
  setup_script: Schema.optional(Schema.NullOr(Schema.String)),
  teardown_script: Schema.optional(Schema.NullOr(Schema.String)),
  status_script: Schema.optional(Schema.NullOr(Schema.String)),
  status_scripts: Schema.optional(Schema.NullOr(StatusScripts)),
  use_worktrees: Schema.optional(Schema.Boolean),
  permission_mode: Schema.optional(Schema.NullOr(PermissionMode)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  /** Absolute, and not the repository. */
  worktrees_root: Schema.optional(Schema.String),
  auto_review: Schema.optional(Schema.Boolean),
  /** 0 to 20. */
  review_rounds: Schema.optional(Schema.Int),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  auto_summary: Schema.optional(Schema.Boolean),
  summarizers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  claude_config_ids: Schema.optional(Schema.NullOr(Schema.Array(AgentConfigId))),
  start_prompt: Schema.optional(Schema.NullOr(Schema.String)),
  review_prompt: Schema.optional(Schema.NullOr(Schema.String)),
  merge_prompt: Schema.optional(Schema.NullOr(Schema.String)),
  /** At most 100 characters; null takes it out of its group. */
  group_name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Refused while one of its agents runs. */
  archived: Schema.optional(Schema.Boolean),
  merge_approval: Schema.optional(Schema.NullOr(Schema.Boolean)),
  require_pr_approval: Schema.optional(Schema.NullOr(Schema.Boolean)),
  github_account: Schema.optional(Schema.NullOr(Schema.String)),
  done_when_merged: Schema.optional(Schema.Boolean),
  use_workflows: Schema.optional(Schema.Boolean),
  pull_requests: Schema.optional(Schema.Boolean),
  watch_pull_requests: Schema.optional(WatchPullRequests),
  /** An http(s) URL with `{pr}` in it. */
  pr_preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  copy_files: Schema.optional(Schema.NullOr(Schema.String)),
  link_folders: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface ProjectPatch extends Schema.Schema.Type<typeof ProjectPatch> {}
