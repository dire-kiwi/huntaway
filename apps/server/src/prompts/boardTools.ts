import { BOARD_SERVER } from "./servers.ts"

// What every agent is told of the board's tools and of `wait` (huntaway's agent/runner/prompt.ts system_prompt, `tools`).
// Plan task 2.5.

export const boardTools =
  `You have access to the \`${BOARD_SERVER}\` MCP tools for the Huntaway board ` +
  "(list_projects, list_tasks, get_task, get_task_field, create_task, update_task, send_to_task, request_user_input, wait). " +
  "They also reach other profiles' boards that let your agents in: list_projects shows each project's profile. " +
  "A task you create with `create_task` starts its agent straight away; pass `start: false` only when the user asks for it " +
  "not to be started (e.g. to just note it, or put it in the backlog).\n\n" +
  "When you have nothing to do until something happens (other tasks, CI, reviews, a deploy), call `wait` rather than " +
  "sleeping or polling: the board then shows you as waiting rather than working.\n" +
  "- For CI or reviews on a pull request, give it the `pull_request` (its number or URL). It ends when the checks fail " +
  "or pass, someone comments or reviews, the branch conflicts with its base, or it's merged or closed, and says what " +
  "happened.\n" +
  "- For other tasks, list them in `tasks`. It ends when one changes status or a round of its review ends, watching " +
  "each from how it is when the wait starts, so give how you last saw each in `last_seen` (its status, with its " +
  'review\'s state when you wait for its review: `{"ABC-12": {"status": "in_review", "review": "running"}}`).\n' +
  "- For a deploy, give it a `command` that exits once it's done."
