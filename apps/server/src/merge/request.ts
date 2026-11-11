import { Result } from "effect"
import type { Project, Task } from "@huntaway/contracts"
import { projectMerge } from "../agents/prompts/project.ts"
import {
  MERGE_DONE,
  mergeCarries,
  mergeIncoming,
  mergeIntoMerged,
  mergeIntoOpen,
  mergeListed,
  mergeMergedInto,
  mergeRequest,
  mergeStackRun,
  mergeWhatInto,
  stackedOnMerged,
  stackedOnPullRequest,
  stackedRestacked,
} from "../prompts/merge.ts"
import { isMerged, isScratch } from "../tasks/checks.ts"
import { mergeHeld, mergingInto, reaching, stackRunTasks, stackWaits } from "../tasks/lanes.ts"
import type { Rows } from "../tasks/lanes.ts"

// What the agent of a task whose turn in the merge queue has come is asked (huntaway's agent/runner/merge.ts
// `request_merge`, `into_merge`, `stacked_merge`): plain functions of the project's rows. A request that can't be made
// (what it merges into was closed, a level below isn't merged) fails with why, and the task needs attention.

const find = (rows: Rows, id: string) => rows.find((t) => t.id === id) ?? null

/**
 * What a merge request says of a task that merges into another task: into that task's branch while it's open, into
 * where it went (`base`) once it's merged.
 */
export const intoMerge = (rows: Rows, task: Task, base: string | null): Result.Result<string, string> => {
  const target = task.merges_into === null ? null : find(rows, task.merges_into)
  if (target === null || mergeHeld(rows, task)) {
    return Result.fail("the task it merges into was closed without being merged, or deleted: choose where it merges now")
  }
  const them = target.key
  if (isMerged(target)) return Result.succeed(mergeIntoMerged(them, base))
  if (target.status === "done") return Result.fail(`${them}, which this task merges into, was closed without being merged: choose where it merges now`)
  if (target.branch === null) return Result.fail(`${them}, which this task merges into, has no branch yet: start it (or set up its worktree) first`)
  return Result.succeed(mergeIntoOpen(them, target.title, target.status, target.branch))
}

/**
 * What a merge request says of a task stacked on another task's or a pull request's branch: a stack level only merges
 * once the task below is merged, into where that went (`base`), restacked there by the board or, if that didn't happen,
 * by its agent as it merges. One stacked on a pull request merges into its branch while that's open.
 */
export const stackedMerge = (rows: Rows, task: Task, base: string | null): Result.Result<string, string> => {
  const b = task.base_branch
  if (b === null || task.branch === null) return Result.succeed("")
  const sf = task.start_from
  if (sf?.type === "task") {
    const other = find(rows, sf.task_id)
    if (other === null) return Result.succeed("")
    const them = other.key
    if (stackWaits(rows, task))
      return Result.fail(`${them}, which this task lands after, isn't merged yet (or it's still to be restacked): it merges after that`)
    // Restacked by the board onto where the level below went once that was merged.
    if (other.branch !== b) {
      return Result.succeed(task.merges_into === null && isMerged(other) && base !== null ? stackedRestacked(them, base, task.github_stack !== null) : "")
    }
    if (isMerged(other)) return Result.succeed(stackedOnMerged(them, base, b))
    return Result.fail(`${them}, which this task lands after, was closed without being merged: choose where it merges now`)
  }
  if (sf?.type === "pull_request") return Result.succeed(stackedOnPullRequest(sf.number, b))
  return Result.succeed("")
}

/** What the request is made of besides the rows. */
export interface MergeRequestInput {
  readonly task: Task
  readonly project: Pick<Project, "merge_prompt"> | null
  /** Where its work goes (`TaskBase.taskBase`). */
  readonly base: string | null
}

/** The merge request (`mergeRequest` and what follows it), or why it can't be made. */
export const mergeRequestText = (rows: Rows, { task, project, base }: MergeRequestInput): Result.Result<string, string> =>
  Result.gen(function* () {
    const stacked = task.merges_into !== null ? yield* intoMerge(rows, task, base) : yield* stackedMerge(rows, task, base)
    // A project's workflow that moves a merged task to Done has its own prompt and finish (6.6).
    let text = mergeRequest({
      approved: task.merge_approval === "approved",
      what: mergeWhatInto(task.branch, base),
      stacked,
      instructions: projectMerge(project),
      merged: MERGE_DONE,
    })
    // A level of a stack merging as one run: the lane is the stack's until its last level.
    if (task.stack_run !== null) {
      const above = stackRunTasks(rows, task.stack_run).filter((t) => t.status !== "done" && t.id !== task.id).length
      if (above > 0) text += mergeStackRun(above)
    }
    const incoming = reaching(rows, task.id).filter((t) => !isScratch(t))
    if (incoming.length > 0) text += mergeIncoming(incoming.map((t) => mergeListed(t.key, t.title, t.status)))
    else if (mergingInto(rows, task.id).length > 0) text += mergeMergedInto
    // Its branch may still have the commits of a task it built on that was closed without being merged (HA-295).
    if (task.carries !== null && task.branch !== null) {
      text += mergeCarries({ key: task.carries.key, commit: task.carries.commit, base, branch: task.branch })
    }
    return text
  })
