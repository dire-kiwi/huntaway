// What a stack's own thread is told of its stack as it is when the run starts, for the end of its instructions
// (HE-105), as a pen's thread is told of its pen (`penBrief`).

export interface StackBriefLevel {
  /** E.g. `WEB-12`. */
  readonly key: string
  readonly id: string
  readonly title: string
  readonly status: string
  /** Merged (done and merged), or closed (done without being merged). */
  readonly done: "merged" | "closed" | null
  readonly running: boolean
  readonly branch: string | null
  readonly base_branch: string | null
  /** Its worktree, once it's set up. */
  readonly worktree: string | null
  readonly pr_url: string | null
  /** Its pull request's stack on GitHub. */
  readonly github_stack: number | null
  readonly restack: "due" | "conflict" | null
  /** The key of the level it lands after, or null for the bottom. */
  readonly after: string | null
}

/** The stack, bottom first, or null once its tasks are no longer a stack. */
export const stackBrief = (
  stack: { readonly title: string; readonly description: string | null; readonly levels: ReadonlyArray<StackBriefLevel> } | null,
): string => {
  if (stack === null) return "\n\nYour stack is gone (its tasks are no longer a stack, or were deleted): tell the user if they ask you to manage it."
  let out = `\n\nYour stack, as it was when this run started: "${stack.title}"${stack.description !== null ? `: ${stack.description}` : ""}\n`
  out += "Its levels, bottom first:\n"
  stack.levels.forEach((l, i) => {
    const state = l.done ?? `${l.status}${l.running ? ", its agent is running" : ""}`
    out += `${i + 1}. ${l.key} [${state}] ${l.title} (id ${l.id})`
    if (l.after !== null) out += `, lands after ${l.after}`
    if (l.branch !== null)
      out += `\n   branch \`${l.branch}\`${l.base_branch !== null ? ` on \`${l.base_branch}\`` : ""}, start ref \`refs/huntaway/start/${l.id}\``
    if (l.worktree !== null) out += `\n   worktree ${l.worktree}`
    if (l.pr_url !== null) out += `\n   pull request ${l.pr_url}${l.github_stack !== null ? ` (in GitHub stack #${l.github_stack})` : ""}`
    if (l.restack !== null) out += `\n   restack ${l.restack === "due" ? "due: the board is restacking it" : "conflict: the board couldn't restack it"}`
    out += "\n"
  })
  return out.trimEnd()
}
