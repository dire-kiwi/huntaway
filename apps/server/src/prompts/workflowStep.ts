import { userSaid } from "./review.ts"
import type { UserReplies } from "./review.ts"

// What a workflow's agent step is asked (huntaway's integrations/workflows/prompt.ts agent): the task, where its work
// is, what the steps before it said, what the step is to do, and how it reports. Plan task 6.6 (`WorkflowEngine`).

/** How much of the task agent's last message, and of an earlier step's output, goes in a prompt. */
const QUOTE_CHARS = 6000

/** Each line quoted, cut to `QUOTE_CHARS` (the workflows' own quoting, which trims first). */
export const workflowQuote = (s: string): string => {
  let t = s.trim()
  const cs = Array.from(t)
  if (cs.length > QUOTE_CHARS) t = `${cs.slice(0, QUOTE_CHARS).join("")} [...]`
  return t
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")
}

/** What an agent step's prompt needs to know about the task's work. */
export interface WorkflowWork {
  readonly key: string
  readonly branch: string
  readonly base: string | null
  readonly commit: string
  /** The branch has no commits of its own: the agent worked somewhere else (or not at all). */
  readonly elsewhere: boolean
  /** Its work starts later than where it left its base branch. */
  readonly own_start: boolean
  readonly last_message: string | null
}

export interface WorkflowStepFacts {
  readonly title: string
  readonly description: string
  readonly pr_url: string | null
  readonly work: WorkflowWork
  readonly workflow: string
  readonly step: string
  /** What the step is asked to do, its templates filled in. */
  readonly instructions: string
  readonly output: "verdict" | "text"
  readonly skills: ReadonlyArray<string>
  readonly codex: boolean
  /** What the steps before it said: (name, output). */
  readonly earlier: ReadonlyArray<readonly [name: string, said: string]>
  readonly replies: UserReplies | null
  /** The serious issues it found the last time it ran, which the agent was asked to fix. */
  readonly recheck: ReadonlyArray<string>
  /** It works on what the steps before it said, not on the task's work. */
  readonly inputOnly: boolean
  /** It goes on from its conversation the last time it ran. */
  readonly continued: boolean
}

export const workflowStep = (t: WorkflowStepFacts): string => {
  const { work } = t
  const key = work.key
  let p = `You are "${t.step}", a step of the workflow "${t.workflow}", for task ${key}: "${t.title}".\n`
  if (t.continued) {
    p += t.inputOnly
      ? "\nThis goes on from your conversation the last time this step ran. Work on what the steps before you say now, below, rather than on what they said then.\n"
      : `\nThis goes on from your conversation the last time this step ran. The work may have changed since: read it as it is now (commit ${work.commit}), rather than going by what you saw then.\n`
  }
  if (t.inputOnly) {
    p +=
      "\nYou work on what the steps before you said, which is below, rather than on the task's changes: you don't need to read " +
      "them unless your instructions ask you to.\n"
    if (t.earlier.length === 0) p += "\nNo step before you wrote any output.\n"
  } else if (t.description.trim() !== "") p += `\nThe task's description:\n\n${t.description.trim()}\n`
  const { branch, commit } = work
  if (t.inputOnly) {
    // Not where the work is.
  } else if (work.elsewhere) {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at commit ` +
      `${commit}), so the agent made its changes somewhere else, such as in another repository, or made none. Find them from what ` +
      "it says it did"
    if (t.pr_url !== null && t.pr_url !== "") p += ` and from the task's pull request, ${t.pr_url}`
    p += " (the gh MCP server's `pr_view` and `pr_diff` tools take a pull request's URL).\n"
    const m = work.last_message?.trim()
    if (m !== undefined && m !== "") p += `\nThe agent's last message:\n\n${workflowQuote(m)}\n`
    else p += "\nThe agent didn't leave a message saying what it did.\n"
  } else if (work.own_start && work.base !== null) {
    const b = work.base
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from commit ${b}, ` +
      "after where it left its base branch, so its pull request's diff (if it has one) also has commits that aren't its own: read " +
      `the branch's changes (\`git diff ${b}...HEAD\`, \`git log ${b}..HEAD\`) rather than \`pr_diff\`.\n`
  } else {
    const fallback = work.base !== null ? `the branch's changes (\`git diff ${work.base}...HEAD\`, \`git log ${work.base}..HEAD\`)` : "the branch's commits"
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull request with the ` +
      `gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and read its changes (\`pr_diff\`). If it has no pull request, read ${fallback} ` +
      "instead.\n"
  }
  if (t.replies !== null && !t.inputOnly) p += userSaid(t.replies.replies, t.replies.earlier > 0)
  for (const [name, said] of t.earlier) p += `\nThe step "${name}" before you said:\n\n${workflowQuote(said)}\n`
  const ins = t.instructions.trim()
  if (ins !== "") p += `\n${ins}\n`
  if (t.skills.length > 0) {
    const named = t.skills.map((s) => `\`${t.codex ? "$" : "/"}${s}\``)
    p +=
      `\nUse ${t.skills.length === 1 ? "this skill" : "these skills"} while you work: ${named.join(", ")}` +
      `${t.codex ? "" : " (invoke each with the `Skill` tool)"}. If a skill asks for something against the rest of this message (changing files, say), ` +
      "follow this message instead.\n"
  }
  if (t.output === "verdict") {
    p +=
      "\nDon't change anything. When you're done, call `submit_review` once. If anything must be fixed before merging (for " +
      "example, a bug you confirmed), the verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it " +
      "is, what goes wrong and how to fix it. Otherwise the verdict is `pass`. Put minor issues and suggestions in the summary, " +
      "and list each of them in `minor_issues` too. Then end your turn with a short summary."
    if (t.recheck.length > 0) {
      p += "\n\nThe last time this step ran it found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n"
      for (const i of t.recheck) p += `\n- ${i}`
    }
  } else {
    p += "\nDon't change anything. Your last message is this step's output, shown as it is on the task: end your turn with only that, without a preamble."
  }
  return p
}
