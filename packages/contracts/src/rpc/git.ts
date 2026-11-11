import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound } from "../errors.ts"
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
 * A task's worktree and its git state (the old `/tasks/{id}/worktree/*`, `/tasks/{id}/diff`). Setting up and tearing
 * down a worktree change the task, which emits `task`. 4.2 adds the Changes tab's methods to this group.
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
).middleware(Auth) {}
