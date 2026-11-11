import { Effect } from "effect"
import type { Project, Task } from "@huntaway/contracts"
import { isMerged } from "../../tasks/checks.ts"

// Where a task's work goes when it merges into or starts from another task (huntaway's db/tasks/stacks.ts `task_base`
// and `stacked_base`; inventory 04, section 2.16). The rest of `merges_into` (lanes, restack, retarget) is 4.8's.

/** Reads a task by id: null when it's gone. */
export type Lookup = (id: string) => Effect.Effect<Task | null>

/** How deep stacks go: each step is to a task it merges into or starts from, which can't lead back. */
const DEPTH = 16

/**
 * The base branch a task's work goes to: the branch of the task it merges into while that's open, and where that went
 * once it's merged; for a task stacked on another (`start_from` a task), where that went once it's merged; else its own
 * base branch, or its project's.
 */
export const taskBase = Effect.fnUntraced(function* (get: Lookup, task: Task, project: Pick<Project, "base_branch"> | null) {
  const own = (t: Task) => {
    const b = t.base_branch ?? project?.base_branch ?? null
    return b !== null && b !== "" ? b : null
  }
  let t = task
  for (let i = 0; i < DEPTH; i++) {
    // One that merges into another task goes to its branch while that's open, and where it went once it's merged.
    if (t.merges_into !== null) {
      const target = yield* get(t.merges_into)
      if (target !== null && isMerged(target)) {
        t = target
        continue
      }
      if (target !== null && target.status !== "done" && target.branch !== null) return target.branch
      // Not made yet (its worktree is set up first), or closed or deleted, which holds the merge until the user says
      // where it goes: compared with where it started meanwhile.
      break
    }
    if (t.start_from?.type !== "task") break
    // Its base branch came from that task as its worktree was made (its branch, or where it went), and setting one of
    // its own drops what it starts from, so it goes where that went, even once the board has deleted that task's branch.
    const other = yield* get(t.start_from.task_id)
    if (other !== null && isMerged(other)) t = other
    else break
  }
  return own(t)
})

/**
 * The task whose branch `taskBase` has `task` go to, when that's a task it merges into or is stacked on (directly, or
 * by way of ones merged since) that isn't merged yet.
 */
export const stackedBase = Effect.fnUntraced(function* (get: Lookup, task: Task) {
  let t = task
  for (let i = 0; i < DEPTH; i++) {
    if (t.merges_into !== null) {
      const target = yield* get(t.merges_into)
      if (target === null) return null
      if (isMerged(target)) {
        t = target
        continue
      }
      return target.status !== "done" && target.branch !== null ? target : null
    }
    if (t.start_from?.type !== "task") return null
    const other = yield* get(t.start_from.task_id)
    if (other === null) return null
    if (isMerged(other)) t = other
    else return other.branch !== null && other.branch === t.base_branch ? other : null
  }
  return null
})
