// What a review found, for the task's agent to fix (huntaway's review.ts fixes_prompt, found, listed). Plan task 4.6.

/** How many serious issues a review found, e.g. "The 2 reviewers found 3 serious issues". */
export const reviewFound = (issues: number, reviewers: number): string => {
  const what = issues === 1 ? "serious issue" : "serious issues"
  return reviewers <= 1 ? `The review found ${issues} ${what}` : `The ${reviewers} reviewers found ${issues} ${what}`
}

/** A review's serious issues as a numbered list. */
export const reviewIssues = (issues: ReadonlyArray<string>): string => issues.map((s, i) => `${i + 1}. ${s}`).join("\n\n")

export const reviewFixes = (issues: ReadonlyArray<string>, reviewers: number): string => {
  // Each reviewer reports what it found, so two may describe the same problem.
  const overlap = reviewers > 1 ? "Each issue says which reviewer found it, and some may be the same problem. " : ""
  return (
    `${reviewFound(issues.length, reviewers)} in your changes:\n\n${reviewIssues(issues)}\n\n${overlap}Fix them, then commit (and push, if the branch has a pull request), and end ` +
    "with a summary of what you changed. You don't have to agree with the reviewer: if you think an issue is mistaken, or " +
    "fixing it needs a decision or information from the user, leave that issue alone and call `request_user_input` " +
    'explaining your reasoning or question, so the task moves to "Needs attention" for the user to decide.'
  )
}
