// What the task's agent is sent by a workflow's send step with no message of its own: the issues the run found
// (huntaway's integrations/workflows/prompt.ts fixes and numbered). Plan task 6.6 (`WorkflowEngine`).

/** A numbered list, a blank line between items. */
export const numbered = (list: ReadonlyArray<string>): string => list.map((s, i) => `${i + 1}. ${s}`).join("\n\n")

export const workflowFixes = (workflow: string, list: ReadonlyArray<string>): string => {
  const what = list.length === 1 ? "a serious issue" : "serious issues"
  return (
    `The workflow "${workflow}" found ${what} in your changes:\n\n${numbered(list)}\n\nFix them, then commit (and push, if the branch has a pull ` +
    "request), and end with a summary of what you changed. You don't have to agree: if you think an issue is mistaken, or fixing it " +
    "needs a decision or information from the user, leave that issue alone and call `request_user_input` explaining your reasoning " +
    'or question, so the task moves to "Needs attention" for the user to decide.'
  )
}
