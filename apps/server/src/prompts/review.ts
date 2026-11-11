import { clip, cutChars, quote } from "./quote.ts"

// What a reviewer is asked (huntaway's review.ts prompt, user_said, and the skills line of start_locked). Plan task 4.6.

/** Where the work is: on the branch (`own_start` when it starts after where it left its base branch), or elsewhere. */
export type ReviewWork = { readonly kind: "branch"; readonly own_start: boolean } | { readonly kind: "elsewhere"; readonly last_message: string | null }

/** What the user told the task's agent: (what the agent said before, the user's message), oldest first, and how many earlier ones were left out. */
export interface UserReplies {
  readonly replies: ReadonlyArray<readonly [said: string | null, text: string]>
  readonly earlier: number
}

/** How much of the agent's last message goes in the prompt. */
export const LAST_MESSAGE_CHARS = 6000
/** How much of each message the user sent goes in, of what the agent said before it, and of all of them (the latest). */
export const REPLY_CHARS = 2000
export const REPLY_CONTEXT_CHARS = 1500
export const REPLIES_CHARS = 12000
/** How many of the user's latest messages are read for the prompt, at most. */
export const REPLIES = 100

const bytes = (s: string) => new TextEncoder().encode(s).length

/**
 * The prompt's part on what the user told the task's agent, so reviewers don't raise again what they've decided. The
 * latest messages, up to `REPLIES_CHARS`, after earlier ones left out if `earlier`.
 */
export const userSaid = (replies: UserReplies["replies"], earlier: boolean): string => {
  const parts: Array<string> = []
  let len = 0
  let cut = earlier
  for (let i = replies.length - 1; i >= 0; i--) {
    const [said, text] = replies[i] ?? [null, ""]
    let part = ""
    const s = said?.trim()
    if (s !== undefined && s !== "") part += `The agent:\n\n${quote(clip(s, REPLY_CONTEXT_CHARS, true))}\n\n`
    part += `The user:\n\n${quote(clip(text, REPLY_CHARS, false))}\n`
    len += bytes(part)
    if (len > REPLIES_CHARS && parts.length > 0) {
      cut = true
      break
    }
    parts.push(part)
  }
  if (parts.length === 0) return ""
  if (cut) parts.push("[Earlier messages left out.]\n")
  parts.reverse()
  return (
    "\nWhat the user told the task's agent in its thread, after what the agent said before each message. The " +
    "decisions they made there stand, such as limitations they accepted and options they turned down: don't raise " +
    `those again as serious issues, unless you find something about them the user didn't know.\n\n${parts.join("\n")}`
  )
}

export interface ReviewFacts {
  /** The task's key, e.g. `WEB-12`. */
  readonly key: string
  readonly title: string
  readonly description: string
  readonly pr_url: string | null
  readonly branch: string
  readonly base: string | null
  /** The commit reviewed, shortened. */
  readonly commit: string
  readonly work: ReviewWork
  /** The serious issues the previous review found, which the agent was asked to fix. */
  readonly fixed: ReadonlyArray<string>
  readonly replies: UserReplies
  /** What to look for: the reviewer's, the project's, or `DEFAULT_REVIEW`, with `reviewSkills` after it. */
  readonly instructions: string
}

/** `instructions` say what to look for; the rest locates the work, says what the user decided, and how to report. */
export const review = (t: ReviewFacts): string => {
  const { branch, base, commit, work } = t
  let p = `Review the work on task ${t.key}: "${t.title}".\n`
  if (t.description.trim() !== "") p += `\nThe task's description:\n\n${t.description.trim()}\n`
  if (work.kind === "branch" && work.own_start && base !== null) {
    const b = base
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from ` +
      `commit ${b}, after where it left its base branch, so its pull request's diff (if it has one) also has commits ` +
      `that aren't its own: review the branch's changes (\`git diff ${b}...HEAD\`) rather than \`pr_diff\`. Read its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) only for its description and comments.\n`
  } else if (work.kind === "branch") {
    const fallback = base !== null ? `the branch's changes (\`git diff ${base}...HEAD\`)` : "the branch's commits"
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and review the pull request's changes ` +
      `(\`pr_diff\`). If it has no pull request, review ${fallback} instead.\n`
  } else {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at ` +
      `commit ${commit}, where it started), so the agent made its changes somewhere else, such as in another ` +
      `repository, or made none. Find its changes from what it says it did`
    if (t.pr_url !== null && t.pr_url !== "") p += ` and from the task's pull request, ${t.pr_url}`
    p +=
      ", and review them: for a pull request in another repository, the gh MCP server's `pr_view` " +
      "and `pr_diff` tools with its URL; for commits in another checkout, read its files and git history " +
      "there. If the agent didn't change anything that needs reviewing, the verdict is `pass` and the summary says so.\n"
    const m = work.last_message?.trim()
    if (m !== undefined && m !== "") p += `\nThe agent's last message:\n\n${quote(cutChars(m, LAST_MESSAGE_CHARS))}\n`
    else p += "\nThe agent didn't leave a message saying what it did.\n"
  }
  p += userSaid(t.replies.replies, t.replies.earlier > 0)
  p +=
    `\n${t.instructions}\n\n` +
    "When you're done, call `submit_review` once. If anything must be fixed before merging (for example, a bug you confirmed), the " +
    "verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it is, what goes wrong and how " +
    "to fix it: they are sent to the task's agent to fix. Otherwise the verdict is `pass`. Put minor issues and " +
    "suggestions in the summary, and list each of them in `minor_issues` too."
  if (t.fixed.length > 0) {
    p += "\n\nThe previous review found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n"
    for (const i of t.fixed) p += `\n- ${i}`
  }
  return p
}

/** The skills a reviewer uses, after its instructions (`/name`, or `$name` on Codex). */
export const reviewSkills = (skills: ReadonlyArray<string>, codex: boolean): string => {
  if (skills.length === 0) return ""
  const named = skills.map((s) => `\`${codex ? "$" : "/"}${s}\``)
  return `\n\nUse ${skills.length === 1 ? "this skill" : "these skills"} while you review: ${named.join(", ")}${codex ? "" : " (invoke each with the `Skill` tool)"}.`
}
