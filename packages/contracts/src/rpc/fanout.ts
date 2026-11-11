import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Task } from "../task.ts"

// 6.11: tasks made together from one prompt (a fan-out), compared and picked (docs/plan/inventory/04-git-review.md §2.18).

/** What the compare view shows of a task besides the task itself. */
export const FanoutFacts = Schema.Struct({
  id: TaskId,
  /** How long its agent has run, all of its runs together (one still going, up to now), and how many runs. */
  run_secs: Schema.Number,
  runs: Schema.Int,
  /** Its agent, or one of its reviewers, is at work. */
  working: Schema.Boolean,
  /** Its worktree's uncommitted changes as `git status --porcelain` lists them (the first 20), and how many. */
  uncommitted: Schema.Array(Schema.String),
  uncommitted_count: Schema.Int,
  /** Why its worktree couldn't be checked for them. */
  uncommitted_error: Schema.NullOr(Schema.String),
  /** Commits in its worktree that no branch, remote branch or tag has (a detached HEAD's): picking keeps the worktree. */
  stray_commits: Schema.Int,
  /** Its branch, if the repository has it, and where it's pushed (`origin/ia/x-1`). */
  branch: Schema.NullOr(Schema.String),
  pushed: Schema.NullOr(Schema.String),
})
export interface FanoutFacts extends Schema.Schema.Type<typeof FanoutFacts> {}

/** What picking one of them did with another. */
export const PickOutcome = Schema.Struct({
  id: TaskId,
  key: Schema.String,
  /** Its agent (or a reviewer) was at work, and was stopped. */
  stopped: Schema.Boolean,
  /** Completed as not done now (rather than done already). */
  completed: Schema.Boolean,
  worktree: Schema.Literals(["removed", "kept", "none"]),
  branch: Schema.Literals(["deleted", "kept", "none"]),
  pushed_branch: Schema.Literals(["deleted", "kept", "none"]),
  pr: Schema.Literals(["closed", "kept", "none"]),
  /** What didn't go as asked, and why. */
  notes: Schema.Array(Schema.String),
})
export interface PickOutcome extends Schema.Schema.Type<typeof PickOutcome> {}

/** What to do with the tasks that aren't picked, besides completing them as not done and removing their worktrees. */
export const PickFanout = Schema.Struct({
  /** Delete their branches, and their pushed copies (unless a pull request kept open has them). */
  delete_branches: Schema.optional(Schema.Boolean),
  /** Close their pull requests. */
  close_prs: Schema.optional(Schema.Boolean),
  /** Remove their worktrees even with uncommitted changes, which are lost. Otherwise those worktrees are kept. */
  discard_uncommitted: Schema.optional(Schema.Boolean),
})
export interface PickFanout extends Schema.Schema.Type<typeof PickFanout> {}

export class FanoutRpcs extends RpcGroup.make(
  /**
   * The tasks made from the same prompt as this one, it among them, in the order they were made (the old `GET
   * /tasks/{id}/fanout`). `Invalid` (`fanout_id`) for a task that wasn't.
   */
  Rpc.make("tasks.fanout", { payload: { id: TaskId }, success: Schema.Array(FanoutFacts), error: Schema.Union([NotFound, Invalid]) }).annotate(
    RequiredScope,
    "read",
  ),
  /**
   * Keeps this task and completes the others from its prompt as not done, stopping their agents and removing their
   * worktrees (and their branches and pull requests, if asked), one pick at a time (the old `POST
   * /tasks/{id}/fanout/pick`). `Conflict` (`changed_meanwhile`) for a task completed as not done itself.
   */
  Rpc.make("tasks.pickFanout", {
    payload: { id: TaskId, pick: PickFanout },
    success: Schema.Struct({ task: Task, results: Schema.Array(PickOutcome) }),
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "git"),
).middleware(Auth) {}
