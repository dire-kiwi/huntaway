import type { Status } from "@huntaway/contracts"

// HE-118: what a set's tasks are told of their set (docs/plan/07-agents.md, Work across repositories): the whole set,
// then for the lead where it works and what it hands on, and for the others that the lead does the set's work.

/** A task of the set as its agents are told of it. */
export interface SetMember {
  readonly key: string
  readonly title: string
  readonly project: string
  readonly repository: string
  /** Its worktree, once it's set up. */
  readonly worktree: string | null
  /** Its branch once git has it, else the set's branch it's to be made on. */
  readonly branch: string | null
  readonly base: string | null
  readonly status: Status
  /** It was closed without being merged. */
  readonly closed: boolean
  readonly lead: boolean
  /** The task being told. */
  readonly self: boolean
  /** The lead's run was given its worktree as it started (always false for the lead and for a follower's run). */
  readonly granted: boolean
}

/** The set as the run of one of its tasks is told of it, the lead first. */
export interface SetBrief {
  readonly members: ReadonlyArray<SetMember>
  /** The run's agent takes no other folders (an ACP agent): the lead is given none of the others' worktrees. */
  readonly noDirs: boolean
}

const COLUMN: { readonly [S in Status]: string } = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  needs_attention: "Needs attention",
  in_review: "In review",
  ready_for_merge: "Ready for merge",
  done: "Done",
}

const line = (m: SetMember): string => {
  const who = [m.lead ? "the lead" : null, m.self ? "this task" : null].filter((x) => x !== null).join(", ")
  const where = m.worktree !== null ? `worktree ${m.worktree}` : "worktree not set up yet"
  const branch = m.branch === null ? "" : ` on branch \`${m.branch}\`${m.base !== null ? ` (from \`${m.base}\`)` : ""}`
  const column = m.closed ? "closed" : COLUMN[m.status]
  const given = m.granted ? "; given to you for this run" : ""
  return `- ${m.key}${who === "" ? "" : ` (${who})`}: project ${m.project}, repository ${m.repository}, ${where}${branch}; ${column}${given}`
}

/** What a task of a set is told of it, as a paragraph after its own; "" for a set of one. */
export const setNote = (set: SetBrief): string => {
  const lead = set.members.find((m) => m.lead)
  const self = set.members.find((m) => m.self)
  if (lead === undefined || self === undefined || set.members.length < 2) return ""
  const list = set.members.map(line).join("\n")
  if (!self.lead) {
    return (
      `\n\nThis task is one of a set of tasks across repositories: one piece of work that changes several repositories, one task ` +
      `in each, all on one branch name. Its lead, ${lead.key} ("${lead.title}"), does the set's work across them and hands each ` +
      `task the work in its own repository. The set, as it was when this run started:\n${list}\n\n` +
      "Work only in this task's own repository, in this worktree. Refer anything outside it to the lead with `send_to_task` " +
      `(task ${lead.key}): changes the other repositories need, their pull requests, or what the set's tasks have to agree on.`
    )
  }
  const given = set.members.filter((m) => m.granted)
  const handed = set.members.filter((m) => !m.lead && !m.granted && !m.closed && m.status !== "done")
  let s =
    `\n\nThis task leads a set of tasks across repositories: one piece of work that changes several repositories, one task in ` +
    `each, all on one branch name. The set's work is yours to plan and do across them. The set, as it was when this run started:\n${list}`
  if (given.length > 0) {
    s +=
      `\n\nThis run was given the worktrees of ${given.map((m) => m.key).join(", ")} besides your own: work and commit in them as in ` +
      "yours, each repository's changes in its own worktree, on its branch. Open each of those repositories' pull requests on " +
      "that repository, from its own worktree and branch, as you open your own. When this run ends with your work finished, the " +
      "board moves each of them that has changes, committed or not, to In review, where it's reviewed and merged as its own " +
      "task, and closes the ones with none as not done."
  } else if (set.noDirs && handed.length > 0) {
    s += "\n\nYour agent can't be given other folders yet, so this run was given none of the set's other worktrees."
  }
  if (handed.length > 0) {
    s +=
      `\n\nDon't work in the worktrees of ${handed.map((m) => m.key).join(", ")}: each is its own agent's. Hand each the work ` +
      "in its repository with `send_to_task` (its key), saying what to change and why, and carry on with your own meanwhile."
  }
  return s
}
