// How an agent in a workflow's column says its work there is done, and what the board does then (huntaway's
// integrations/workflows/engine/columns.ts done_note and merge_finish). `then`: what the board does next, each as the
// workflow's graph says it ("moves the task to Done"…). Plan task 6.6 (`WorkflowEngine`).

const listed = (then: ReadonlyArray<string>): string =>
  then.length === 1 ? (then[0] ?? "") : `${then.slice(0, -1).join(", ")} and ${then[then.length - 1] ?? ""}`

/** After a column's prompt; "" when there's nothing to say. `finish`: the column waits for `finish_work`. */
export const workflowDone = (then: ReadonlyArray<string>, finish: boolean): string => {
  if (then.length === 0 && !finish) return ""
  let p = finish
    ? "When the work you were asked for here is complete, call `finish_work`, then end your turn with a summary of what you did. A turn that ends " +
      "without it leaves the task in Needs attention."
    : "When you're done, end your turn with a summary of what you did."
  if (then.length > 0) p += ` The board then ${listed(then)}.`
  return p
}

/** How the merging agent says it's merged when the project's workflow moves the task to Done (in place of `MERGE_DONE`). */
export const workflowMergeFinish = (then: ReadonlyArray<string>): string =>
  `Once it is merged, call \`finish_work\`, then end your turn with a summary of what you did: the board then ${listed(then)}. ` +
  "Don't set the task's status yourself. A turn that ends without `finish_work` leaves the task in Needs attention."
