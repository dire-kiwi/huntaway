// What the agent is sent when its todo list holds its task in In progress at the end of a run (HA-330; huntaway's
// agent/runner/todos.ts nudge_text). Plan task 2.6.

/** How the message starts, which tells it from the board's others. */
export const TODO_NUDGE = "Your todo list still has unfinished items"

/** The items as a Markdown list, each with its status. */
export const todoList = (items: ReadonlyArray<{ readonly text: string; readonly status: string }>): string =>
  items.map((x) => `- [${x.status === "in_progress" ? "in progress" : x.status}] ${x.text}`).join("\n")

export const todoNudge = (items: ReadonlyArray<{ readonly text: string; readonly status: string }>): string =>
  `${TODO_NUDGE}, so the task stays in In progress until the list is complete:\n\n${todoList(items)}\n\n` +
  "Finish them. If some no longer apply, mark them completed or take them off the list (with TodoWrite, or by updating your plan)."
