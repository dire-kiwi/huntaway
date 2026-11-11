import type { Project, Task } from "@huntaway/contracts"
import { slugify } from "../paths.ts"

/**
 * The name of a task's worktree folder in the project's worktrees folder. A task that had a worktree before (removed once
 * merged, say) gets its folder back, named after its branch (even if the project's key has changed since), so its
 * agent's conversation, which is kept by folder, carries on even if the task was renamed.
 */
export const folderName = (project: Pick<Project, "key" | "former_keys">, task: Pick<Task, "branch" | "title" | "number">): string => {
  let fromBranch: string | null = null
  if (task.branch !== null) {
    for (const k of [project.key, ...project.former_keys]) {
      const prefix = `ia/${k.toLowerCase()}-`
      if (task.branch.startsWith(prefix)) {
        fromBranch = task.branch.slice(prefix.length)
        break
      }
    }
  }
  if (fromBranch !== null && fromBranch !== "" && !fromBranch.includes("/")) return fromBranch
  const slug = slugify(task.title, 40)
  return slug === "" ? `${task.number}` : `${task.number}-${slug}`
}
