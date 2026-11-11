import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Task } from "../task.ts"

/**
 * A task's changes against where its work starts (the old `GET /tasks/{id}/diff`, `DiffResult`): `available: false` with
 * `reason` when there is nothing to show (not a git repository, no worktree or branch); `branch` when the task has no
 * worktree and this is what its branch has.
 */
export const DiffResult = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** The folder the changes are in: the task's worktree, or the project's repository. */
  dir: Schema.optional(Schema.String),
  /** The base branch it is compared with. */
  base: Schema.optional(Schema.NullOr(Schema.String)),
  /** Where its own work starts. */
  merge_base: Schema.optional(Schema.NullOr(Schema.String)),
  /** `git log --oneline` of its commits. */
  commits: Schema.optional(Schema.String),
  stat: Schema.optional(Schema.String),
  /** Cut at 2,000,000 characters. */
  patch: Schema.optional(Schema.String),
  untracked: Schema.optional(Schema.Array(Schema.String)),
  branch: Schema.optional(Schema.String),
})
export interface DiffResult extends Schema.Schema.Type<typeof DiffResult> {}

/**
 * A file with changes, as `git status --short` shows it: its index (`x`) and working tree (`y`) state, each one of `M`,
 * `A`, `D`, `R`, `C`, `T`, a space for none, `?` for untracked, and the two sides of a conflict (`UU`, `AA`, …).
 */
export const GitFile = Schema.Struct({
  path: Schema.String,
  /** Where a renamed or copied file came from. */
  orig_path: Schema.NullOr(Schema.String),
  x: Schema.String,
  y: Schema.String,
})
export interface GitFile extends Schema.Schema.Type<typeof GitFile> {}

export const GitCommit = Schema.Struct({
  sha: Schema.String,
  author: Schema.String,
  /** Unix seconds. */
  time: Schema.Finite,
  subject: Schema.String,
  /** Made on the task's branch (after where it left its base), as opposed to before it. */
  on_branch: Schema.Boolean,
  /** Not on the branch's upstream yet. */
  unpushed: Schema.Boolean,
})
export interface GitCommit extends Schema.Schema.Type<typeof GitCommit> {}

/** A stash: its place in the list and its commit, both of which `git.stash` takes. */
export const GitStash = Schema.Struct({
  index: Schema.Int,
  sha: Schema.String,
  /** Unix seconds. */
  time: Schema.Finite,
  subject: Schema.String,
})
export interface GitStash extends Schema.Schema.Type<typeof GitStash> {}

/** What a repository is in the middle of. */
export const RepoState = Schema.Literals(["rebasing", "merging", "cherry-picking", "reverting"])
export type RepoState = typeof RepoState.Type

/**
 * The Changes tab's view of a task's repository (the old `GET /tasks/{id}/git`), at the top of the folder `git.taskDiff`
 * shows (its worktree once ready, else its project's repository). `available: false` with `reason` when that isn't a git
 * repository; the rest only when it is.
 */
export const GitStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** The top of the working tree. */
  dir: Schema.optional(Schema.String),
  /** Where the project's folder is in it (`web/`) when it's only part of the repository: the files and commits are its own. */
  folder: Schema.optional(Schema.NullOr(Schema.String)),
  /** Null before the first commit. */
  head: Schema.optional(Schema.NullOr(Schema.String)),
  /** Null when detached. */
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  upstream: Schema.optional(Schema.NullOr(Schema.String)),
  ahead: Schema.optional(Schema.Int),
  behind: Schema.optional(Schema.Int),
  /** The base branch the task's work is compared with, and where its own work starts. */
  base: Schema.optional(Schema.NullOr(Schema.String)),
  merge_base: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(RepoState)),
  /** At most 5,000; `truncated` when there were more. */
  files: Schema.optional(Schema.Array(GitFile)),
  truncated: Schema.optional(Schema.Boolean),
  /** Up to 300 on the branch since where its work starts, then 30 from before; without a start, the latest 300. */
  commits: Schema.optional(Schema.Array(GitCommit)),
  /** None when the project's folder is only part of the repository (the repository's stashes aren't the folder's). */
  stashes: Schema.optional(Schema.Array(GitStash)),
})
export interface GitStatus extends Schema.Schema.Type<typeof GitStatus> {}

/**
 * A file's (or folder's) diff: `too_large` (over 4 MiB) with no patch; one that isn't UTF-8 as a lossy `preview` with
 * `not_utf8` and no patch, since lines patched from it would write U+FFFD back into the file.
 */
export const GitFileDiff = Schema.Struct({
  patch: Schema.String,
  too_large: Schema.optional(Schema.Boolean),
  not_utf8: Schema.optional(Schema.Boolean),
  preview: Schema.optional(Schema.String),
})
export interface GitFileDiff extends Schema.Schema.Type<typeof GitFileDiff> {}

/** A commit's metadata and changes (a merge's against its first parent); a stash's has only `patch`. Patches are cut at 4 MiB. */
export const GitShown = Schema.Struct({
  sha: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  /** Unix seconds. */
  time: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
  patch: Schema.String,
})
export interface GitShown extends Schema.Schema.Type<typeof GitShown> {}

/** `push` stashes; `apply`, `pop` and `drop` take a stash by its index and its commit. */
export const GitStashAction = Schema.Literals(["push", "apply", "pop", "drop"])
export type GitStashAction = typeof GitStashAction.Type
/** What `push` stashes: `all` (untracked files too), `staged`, or `unstaged` (all but what's staged, which stays). */
export const GitStashMode = Schema.Literals(["all", "staged", "unstaged"])
export type GitStashMode = typeof GitStashMode.Type
export const GitResetMode = Schema.Literals(["soft", "mixed", "hard"])
export type GitResetMode = typeof GitResetMode.Type

/**
 * What the Changes tab's methods fail with: the task (`NotFound`); a path outside the repository or the project's folder,
 * a revision that isn't a hash, a missing message (`Invalid`); git's own refusal (`Conflict`); git that would not run.
 */
const ChangesErrors = Schema.Union([NotFound, Invalid, Conflict, Unavailable])
const Paths = Schema.Array(Schema.String)

/**
 * A task's worktree and its git state (the old `/tasks/{id}/worktree/*`, `/tasks/{id}/diff`, `/tasks/{id}/git…`). Setting
 * up and tearing down a worktree change the task, which emits `task`. The Changes tab's methods read at `read` and write
 * at `git`; git's own message when it refuses is a `Conflict` (`git_refused`, the old 409), and so is what would act on
 * the whole repository when the project's folder is only part of it (`whole_repository`).
 */
export class GitRpcs extends RpcGroup.make(
  /**
   * Set up the task's worktree (nothing if it is ready): `Conflict` (`agent_running`) while its agent or a reviewer works
   * there, `Invalid` (`worktree`) with git's or the setup script's reason when it fails.
   */
  Rpc.make("git.setupWorktree", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Conflict, Invalid]) }).annotate(RequiredScope, "git"),
  /**
   * Remove the task's worktree after its teardown script; its branch is kept unless `delete_branch`. Refused
   * (`Conflict`, `worktree_kept`, with the reason and up to 2,000 characters of what isn't committed) when something
   * would be lost, unless `force`; `agent_running` while its agent or a reviewer works there.
   */
  Rpc.make("git.teardownWorktree", {
    payload: { id: TaskId, force: Schema.optional(Schema.Boolean), delete_branch: Schema.optional(Schema.Boolean) },
    success: Task,
    error: Schema.Union([NotFound, Conflict]),
  }).annotate(RequiredScope, "git"),
  /** The task's own work: commits, uncommitted and untracked changes, against where it starts. */
  Rpc.make("git.taskDiff", { payload: { id: TaskId }, success: DiffResult, error: NotFound }).annotate(RequiredScope, "read"),
  /** The Changes tab's view: files, branch, commits, stashes. */
  Rpc.make("git.status", { payload: { id: TaskId }, success: GitStatus, error: ChangesErrors }).annotate(RequiredScope, "read"),
  /** A file's (or folder's) unstaged changes, its `staged` ones, or an `untracked` file as if added; without rename detection. */
  Rpc.make("git.diff", {
    payload: { id: TaskId, path: Schema.String, staged: Schema.optional(Schema.Boolean), untracked: Schema.optional(Schema.Boolean) },
    success: GitFileDiff,
    error: ChangesErrors,
  }).annotate(RequiredScope, "read"),
  /** A commit (`rev`, a hash) or, with `stash`, a stash (its commit), with its untracked files. */
  Rpc.make("git.show", {
    payload: { id: TaskId, rev: Schema.String, stash: Schema.optional(Schema.Boolean) },
    success: GitShown,
    error: ChangesErrors,
  }).annotate(RequiredScope, "read"),
  /** Stage the files as they are (removed ones too), or everything (no paths). */
  Rpc.make("git.stage", { payload: { id: TaskId, paths: Paths }, success: Schema.Void, error: ChangesErrors }).annotate(RequiredScope, "git"),
  /** Put the files (or everything) in the index back as they are in HEAD. */
  Rpc.make("git.unstage", { payload: { id: TaskId, paths: Paths }, success: Schema.Void, error: ChangesErrors }).annotate(RequiredScope, "git"),
  /** Throw away the files' unstaged changes (back to the index) or, with `staged`, all of them (back to HEAD); untracked files are deleted. */
  Rpc.make("git.discard", {
    payload: { id: TaskId, paths: Paths, staged: Schema.optional(Schema.Boolean) },
    success: Schema.Void,
    error: ChangesErrors,
  }).annotate(RequiredScope, "git"),
  /** Apply a patch of chosen lines to the index (`cached`) or the working tree, `reverse`d to unstage or discard them. */
  Rpc.make("git.apply", {
    payload: { id: TaskId, patch: Schema.String, cached: Schema.optional(Schema.Boolean), reverse: Schema.optional(Schema.Boolean) },
    success: Schema.Void,
    error: ChangesErrors,
  }).annotate(RequiredScope, "git"),
  /** Commit what is staged; `amend` into the last commit (its message kept unless one is given); `reword` only its message. The new HEAD. */
  Rpc.make("git.commit", {
    payload: { id: TaskId, message: Schema.String, amend: Schema.optional(Schema.Boolean), reword: Schema.optional(Schema.Boolean) },
    success: Schema.Struct({ head: Schema.String }),
    error: ChangesErrors,
  }).annotate(RequiredScope, "git"),
  /**
   * Stash changes (`push`; `mode` is `all` when not given; an optional `message`), or apply, pop or drop the stash at
   * `index` whose commit is `sha`, refused (`changed_meanwhile`) when the list has changed since. What git said.
   */
  Rpc.make("git.stash", {
    payload: {
      id: TaskId,
      action: GitStashAction,
      mode: Schema.optional(GitStashMode),
      message: Schema.optional(Schema.String),
      index: Schema.optional(Schema.Int),
      sha: Schema.optional(Schema.String),
    },
    success: Schema.Struct({ output: Schema.String }),
    error: ChangesErrors,
  }).annotate(RequiredScope, "git"),
  /** Move the branch to a commit (a hash): `soft`, `mixed` or `hard`. */
  Rpc.make("git.reset", { payload: { id: TaskId, rev: Schema.String, mode: GitResetMode }, success: Schema.Void, error: ChangesErrors }).annotate(
    RequiredScope,
    "git",
  ),
).middleware(Auth) {}
