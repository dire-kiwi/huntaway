import type { Project, Task } from "@huntaway/contracts"
import { slugify } from "../../platform/slug.ts"

/**
 * The name of a task's worktree folder in the project's worktrees folder. A task that had a worktree before (removed once
 * merged, say) gets its folder back, named after its branch (even if the project's key has changed since), so its
 * agent's conversation, which is kept by folder, carries on even if the task was renamed. A set's task (HE-117) whose
 * branch is the set's, made or not, from another project's key (its lead's), has its folder named after that branch too,
 * with its own number first so that two projects' worktrees in one folder don't meet: `<number>-<branch without ia/>`.
 */
export const folderName = (project: Pick<Project, "key" | "former_keys">, task: Pick<Task, "branch" | "title" | "number" | "set_branch">): string => {
  const set = task.set_branch ?? null
  // Its branch, or the set's it's to be made on.
  const branch = task.branch ?? set
  let fromBranch: string | null = null
  if (branch !== null) {
    for (const k of [project.key, ...project.former_keys]) {
      const prefix = `ia/${k.toLowerCase()}-`
      if (branch.startsWith(prefix)) {
        fromBranch = branch.slice(prefix.length)
        break
      }
    }
  }
  if (fromBranch !== null && fromBranch !== "" && !fromBranch.includes("/")) return fromBranch
  if (set !== null && branch === set && set.startsWith("ia/")) {
    const rest = set.slice("ia/".length)
    if (rest !== "" && !rest.includes("/")) return `${task.number}-${rest}`
  }
  const slug = slugify(task.title, 40)
  return slug === "" ? `${task.number}` : `${task.number}-${slug}`
}
