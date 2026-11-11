// The instructions a project without its own gives an agent as a task moves across the board (huntaway's
// agent/prompts.ts): when it starts (In progress, plan task 2.5), when its work is reviewed (In review, plan task 4.6),
// and when it is merged (Ready for merge, plan task 4.7). A project replaces each in its settings.

export const DEFAULT_START = "Start working on this task."

export const DEFAULT_REVIEW =
  "Look for correctness problems: bugs, crashes, data loss, security holes, a broken build or " +
  "tests, and anything that doesn't do what the task asks. Read the surrounding code where you need to. If you have a code " +
  "review skill or command (such as /code-review), use it."

export const DEFAULT_MERGE =
  "Commit any outstanding work, then merge its pull request if it has one (e.g. with the gh tools' pr_merge), " +
  "otherwise merge the branch directly. Follow the project's own merge instructions (e.g. in CLAUDE.md) and resolve any " +
  "conflicts."

/** The project fields holding each prompt's instructions, and their defaults (`GET /default-prompts`). */
export const PROJECT_PROMPT_DEFAULTS = { start_prompt: DEFAULT_START, review_prompt: DEFAULT_REVIEW, merge_prompt: DEFAULT_MERGE } as const
