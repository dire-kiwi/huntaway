import type { Task } from "@huntaway/contracts"
import type { StackLevel } from "../../prompts/codeTask.ts"
import { stackBrief } from "../../prompts/stackBrief.ts"
import { isMerged } from "../../tasks/checks.ts"
import { stackedBelow, stackOf } from "../../tasks/lanes.ts"
import type { Rows } from "../../tasks/lanes.ts"

// HE-105: what a stack's thread and its levels are told of the stack, as plain functions of its project's task rows
// (`lanes.ts` `stackOf`).

/** The stack's title: its own, else its bottom task's. */
const titleOf = (bottom: Task) => bottom.stack_title?.trim() || bottom.title

/** Where `task` is in its stack, told it's managed by thread `thread` (its key); null for a task in no stack. */
export const stackLevelOf = (rows: Rows, task: Task, thread: string): StackLevel | null => {
  const st = stackOf(rows, task)
  if (st === null) return null
  const at = st.levels.findIndex((l) => l.id === task.id)
  return { title: titleOf(st.bottom), level: at + 1, levels: st.levels.length, thread }
}

/** What a stack thread under `parent` (a level of its stack) is told of the stack; `parent` null once it's gone. */
export const stackBriefOf = (rows: Rows, parent: Task | null): string => {
  const st = parent === null ? null : stackOf(rows, parent)
  if (st === null) return stackBrief(null)
  const ids = new Set(st.levels.map((l) => l.id))
  return stackBrief({
    title: titleOf(st.bottom),
    description: st.bottom.stack_description?.trim() || null,
    levels: st.levels.map((t) => {
      const below = stackedBelow(rows, t)?.task ?? null
      return {
        key: t.key,
        id: t.id,
        title: t.title,
        status: t.status,
        done: isMerged(t) ? "merged" : t.status === "done" ? "closed" : null,
        running: t.running,
        branch: t.branch,
        base_branch: t.base_branch,
        worktree: t.worktree_state === "ready" ? t.worktree_path : null,
        pr_url: t.pr_url,
        github_stack: t.github_stack,
        restack: t.restack,
        after: below !== null && ids.has(below.id) ? below.key : null,
      }
    }),
  })
}
