import type { Task, TaskId } from "@huntaway/contracts"
import type { FinishDecision } from "./finish.ts"

// A set's lead's runs (HE-118; docs/plan/07-agents.md, Work across repositories): which of the set's other tasks a lead's
// run is given to work in, and what its end does with them. Plain functions over the set's rows; `LaunchFacts` gives the
// worktrees, `RunEnds` moves the tasks.

/** A set's lead: it has the set's branch name and no lead of its own (its others name it in `lead_id`). */
export const isLead = (t: Pick<Task, "kind" | "lead_id" | "set_branch">): boolean =>
  t.kind === "task" && (t.lead_id ?? null) === null && typeof t.set_branch === "string" && t.set_branch !== ""

/**
 * A task of a set waiting for its lead: in To do, with no run of its own. Once it has left To do, its worktree is its
 * own agent's alone.
 */
export const awaitsLead = (t: Pick<Task, "kind" | "lead_id" | "status" | "running">): boolean =>
  t.kind === "task" && (t.lead_id ?? null) !== null && t.status === "todo" && !t.running

/** A follower whose worktree a lead's run is given as it starts: one waiting for its lead, with its worktree set up. */
export const takesGrant = (t: Pick<Task, "kind" | "lead_id" | "status" | "running" | "worktree_state" | "worktree_path">): boolean =>
  awaitsLead(t) && t.worktree_state === "ready" && t.worktree_path !== null

/**
 * The lead's run ended with its work finished: wherever it would have gone to In review before HE-66's hold. That is
 * In review itself, held in In progress for its review (`review`), or handed to its workflow's column (`workDone`).
 */
export const leadFinished = (d: Pick<FinishDecision, "columns" | "review" | "workDone">): boolean => d.columns.status === "in_review" || d.review || d.workDone

/** A follower as the end of its lead's run decides on it: its row, and whether it has work (`TaskBase.hasWorkToMerge`). */
export interface FollowerFacts {
  readonly task: Pick<Task, "id" | "kind" | "lead_id" | "status" | "running">
  /** Commits its base doesn't have, or uncommitted changes in its worktree (ignored files left out); true when unknown. */
  readonly work: boolean
}

/** What the end of a lead's run does with one of its followers. */
export type FollowerMove =
  /** It has work: to In review, a board move from To do (its reviews and pull request follow as for any). */
  | { readonly _tag: "Review"; readonly task: TaskId }
  /** It has none: closed as not done ("no changes in this repository"). */
  | { readonly _tag: "Close"; readonly task: TaskId }

/**
 * What the end of a set's lead's run, decided as `decision` (`decideFinish`), does with the set's other tasks: nothing
 * unless it finished its work (`leadFinished`); then each waiting for its lead (`awaitsLead`) goes to In review with
 * work, or is closed as not done without. Those already past To do are left alone: the lead couldn't write in them.
 */
export const decideFollowers = (
  decision: Pick<FinishDecision, "columns" | "review" | "workDone">,
  followers: ReadonlyArray<FollowerFacts>,
): ReadonlyArray<FollowerMove> =>
  leadFinished(decision) ? followers.filter((f) => awaitsLead(f.task)).map((f): FollowerMove => ({ _tag: f.work ? "Review" : "Close", task: f.task.id })) : []

/** Why a follower with nothing to merge was closed. */
export const NO_CHANGES = "no changes in this repository"
