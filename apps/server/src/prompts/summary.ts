import { cutChars, quote } from "./quote.ts"

// What a summarizer is asked: a summary of a task's changes for the user to read before merging (huntaway's
// review/summary.ts prompt and DEFAULT_WRITING). Plan task 4.6.

/** How the board asks for a summary to be written, unless the summarizer has a prompt of its own. */
export const SUMMARY_WRITING =
  "\nThe user reads your summary before they merge the work, to see what it does without reading the whole diff. Write " +
  "it in Markdown, briefly: start with a sentence or two on what changed and why, then the main changes (grouped by " +
  "area, naming the files or modules where it helps), any decisions or behaviour changes worth knowing about, and " +
  "how to try it if that isn't obvious. Leave out what the diff makes plain at a glance, and don't review the work or " +
  "pad it out.\n"

/** How much of the agent's last message goes in the prompt. */
const LAST_MESSAGE_CHARS = 6000

export interface SummaryFacts {
  /** The task's key, e.g. `WEB-12`. */
  readonly key: string
  readonly title: string
  readonly description: string
  readonly pr_url: string | null
  /** What its passed review said, if it has one. */
  readonly review: string | null
  readonly branch: string
  readonly base: string | null
  readonly commit: string
  /** The branch has no commits of its own: the agent's `last_message` says where the work is. */
  readonly elsewhere: boolean
  /** Its work starts after where it left its base branch, at `base`. */
  readonly own_start: boolean
  readonly last_message: string | null
  /** The summarizer's own prompt and skills. */
  readonly prompt: string | null
  readonly skills: ReadonlyArray<string>
  readonly codex: boolean
}

export const summary = (t: SummaryFacts): string => {
  const { branch, base, commit } = t
  let p = `Summarise the changes made for task ${t.key}: "${t.title}".\n`
  if (t.description.trim() !== "") p += `\nThe task's description:\n\n${t.description.trim()}\n`
  if (!t.elsewhere && t.own_start && base !== null) {
    const b = base
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from ` +
      `commit ${b}, after where it left its base branch, so its pull request's diff (if it has one) also has commits ` +
      `that aren't its own: read the branch's changes (\`git diff ${b}...HEAD\`, and \`git log ${b}..HEAD\`) rather than ` +
      `\`pr_diff\`. Read its pull request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) only for its description.\n`
  } else if (!t.elsewhere) {
    const fallback = base !== null ? `the branch's changes (\`git diff ${base}...HEAD\`, and \`git log ${base}..HEAD\`)` : "the branch's commits"
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and read its changes (\`pr_diff\`). If it has no ` +
      `pull request, read ${fallback} instead.\n`
  } else {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at ` +
      `commit ${commit}), so the agent made its changes somewhere else, such as in another repository. Find them from ` +
      `what it says it did`
    if (t.pr_url !== null && t.pr_url !== "") p += ` and from the task's pull request, ${t.pr_url}`
    p += ".\n"
    const m = t.last_message?.trim()
    if (m !== undefined && m !== "") p += `\nThe agent's last message:\n\n${quote(cutChars(m, LAST_MESSAGE_CHARS))}\n`
    else p += "\nThe agent didn't leave a message saying what it did.\n"
  }
  const r = t.review?.trim()
  if (r !== undefined && r !== "") p += `\nIts review passed. The reviewer said:\n\n${quote(r)}\n`
  const custom = t.prompt?.trim()
  if (custom !== undefined && custom !== "") p += `\nThe user reads your summary before they merge the work. Write it as they ask:\n\n${custom}\n`
  else p += SUMMARY_WRITING
  if (t.skills.length > 0) {
    const named = t.skills.map((s) => `\`${t.codex ? "$" : "/"}${s}\``)
    p +=
      `\nUse ${t.skills.length === 1 ? "this skill" : "these skills"} while you write the summary: ${named.join(", ")}${t.codex ? "" : " (invoke each with the `Skill` tool)"}. ` +
      "If a skill asks for something against the rest of this message (changing files, or ending with more than the summary), follow this message instead.\n"
  }
  p += "\nDon't change anything. Your last message is the summary, shown as it is on the task: end your turn with only the summary, without a preamble."
  return p
}
