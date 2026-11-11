// A merge that waits for the user's approval (huntaway's review/merge_gate.ts): what the agent is asked to summarise
// first, and why its own merge is refused meanwhile. Plan task 4.7 (`MergeGate`).

/** Ask the agent to summarise what its merge would bring in, without merging. `what`: "branch `x` into `main`". */
export const mergeSummaryRequest = (what: string): string =>
  'The user moved this task to "Ready for merge", and approves each merge before it happens. Summarize what will be merged ' +
  `(${what}): what changes, what it fixes or adds, how it was checked, anything left out or still uncertain, and the pull ` +
  "request if it has one. If there's work the merge would include that isn't committed or pushed yet, commit and push it first, " +
  "so the summary covers what will be merged.\n\nDo not merge yet: merging is disabled until the user approves. End your turn " +
  "with the summary, and the board asks the user to approve or deny the merge. Once they approve it, you're asked to merge."

/** What `mergeSummaryRequest` says is merged: the branch, or the task's work, into the base (`main`, shown in backticks) or the base branch. */
export const mergeWhat = (branch: string | null, base: string | null): string => {
  const into = base !== null ? `\`${base}\`` : "the base branch"
  return branch !== null ? `branch \`${branch}\` into ${into}` : `this task's work into ${into}`
}

/** Why a merge is refused while the user's approval is pending. */
export const mergeAwaitsApproval =
  "Merging is disabled: the user hasn't approved this merge yet. Don't merge: summarize what will be merged and end your turn, " +
  "and the board asks the user to approve it. Once they do, you're asked to merge."

/** Why a merge is refused in a project whose merges need the user's approval, before it was asked. */
export const mergeNeedsApproval =
  "Merging is disabled: merges in this project need the user's approval, and it hasn't been given. The user approves a merge " +
  'after the task is moved to "Ready for merge" (with update_task, when you\'re asked to merge it) and its agent has summarized ' +
  "what will be merged."
