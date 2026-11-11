// What a thread under a task is told: a reviewer, a summarizer, or a workflow's agent step (huntaway's
// agent/runner/prompt.ts system_prompt, the review branch). Plan task 2.5; the threads are made by plan tasks 4.6 and 6.6.

export interface ReviewThreadFacts {
  readonly role: "review" | "summary" | "workflow"
  /** The task's key, e.g. `WEB-12` (`T-0` when the task is gone). */
  readonly key: string
  readonly title: string
  /** The task's worktree, when it is ready. */
  readonly worktree: { readonly path: string | null; readonly branch: string | null } | null
}

export const reviewThread = (t: ReviewThreadFacts): string => {
  const role = t.role === "workflow" ? "You run a step of a workflow" : t.role === "summary" ? "You summarise the changes made" : "You are the code reviewer"
  let s = `${role} for task ${t.key} ("${t.title}") on the Huntaway board, a kanban board where each task is worked by its own Claude agent.`
  if (t.worktree !== null) {
    s += ` Your working directory is that task's git worktree at ${t.worktree.path ?? "?"}${t.worktree.branch !== null ? ` on branch \`${t.worktree.branch}\`` : ""}.`
  }
  s +=
    t.role === "workflow"
      ? "\n\nRead only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
        "board. Don't call `request_user_input`. Each message says what the step is to do and how to report: call " +
        "`submit_review` only when it asks for a verdict."
      : t.role === "summary"
        ? "\n\nRead only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
          "board. Don't call `request_user_input` or `submit_review`. Your last message is the summary of the changes " +
          "the user reads before merging them."
        : "\n\nReview only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
          "board. Don't call `request_user_input`. When the review is complete, call `submit_review` exactly once " +
          "with your verdict, then end your turn with a short summary of the review."
  return s
}
