import type { Project, Reviewer } from "@huntaway/contracts"
import { DEFAULT_MERGE, DEFAULT_REVIEW, DEFAULT_START } from "../../prompts/projectDefaults.ts"

// A project's own instructions for the prompts the board sends as a task moves across it, or the defaults (huntaway's
// agent/prompts.ts start, review, review_by, merge). The board adds what it relies on around them.

/** `own`, trimmed, unless it is blank: then `fallback`. */
const ownOr = (own: string | null | undefined, fallback: string): string => {
  const s = own?.trim()
  return s === undefined || s === "" ? fallback : s
}

/** What a task's agent is told to do when it starts, after the task's title and description (plan task 2.5). */
export const projectStart = (project: Pick<Project, "start_prompt"> | null): string => ownOr(project?.start_prompt, DEFAULT_START)

/** What the reviewer looks for, after the task and where its changes are (plan task 4.6). */
export const projectReview = (project: Pick<Project, "review_prompt"> | null): string => ownOr(project?.review_prompt, DEFAULT_REVIEW)

/** What the reviewer `own` looks for: its own instructions if it has some, else the project's (plan task 4.6). */
export const reviewerInstructions = (project: Pick<Project, "review_prompt"> | null, own: Pick<Reviewer, "prompt">): string =>
  ownOr(own.prompt, projectReview(project))

/** How the agent merges, after which branch to merge into which (plan task 4.7). */
export const projectMerge = (project: Pick<Project, "merge_prompt"> | null): string => ownOr(project?.merge_prompt, DEFAULT_MERGE)
