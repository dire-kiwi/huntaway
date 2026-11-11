// How a group task runs its tasks (huntaway's agent/runner/prompt.ts system_prompt, `coordinate`; a legacy subproject's
// agent was told it too). Plan task 2.5.

export const coordinate =
  "- Follow them with `list_tasks` and `get_task`, and guide their agents with `send_to_task`.\n" +
  "- While they work, wait for them with `wait` (listing them in `tasks`) rather than ending your turn.\n" +
  "- Run tasks that build on each other one after the other, and independent ones in parallel."
