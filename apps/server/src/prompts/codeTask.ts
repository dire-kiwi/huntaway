import type { StartFrom } from "@huntaway/contracts"
import { askAndFinish } from "./askAndFinish.ts"
import { boardTools } from "./boardTools.ts"

// What an ordinary task in a project is told (huntaway's agent/runner/prompt.ts system_prompt, the last branch), without
// the legacy subproject paragraphs (subprojects are gone). Plan task 2.5; worktrees, stacks and pull requests fill its
// facts from plan tasks 4.1, 4.4 and 4.8.

/** Where a task with its own branch opens its pull request: the remote it pushes to, and the GitHub repository. */
export interface Github {
  readonly remote: string
  /** `OWNER/REPO`. */
  readonly repo: string
}

export interface CodeTaskFacts {
  /** Its project's key (`T` with none). */
  readonly key: string
  readonly number: number
  readonly title: string
  readonly project: { readonly name: string; readonly repo_path: string; readonly base_branch: string | null } | null
  /** Whether it opens a pull request, as its project's settings say (always, with no project). */
  readonly pullRequests: boolean
  readonly worktree_path: string | null
  readonly branch: string | null
  readonly base_branch: string | null
  readonly start_from: StartFrom | null
  readonly merges_into: string | null
  readonly github_stack: number | null
  /** The task it merges into, while that is not done. */
  readonly target: { readonly number: number; readonly title: string; readonly branch: string | null } | null
  /** Where it opens its pull request, if its repository is on GitHub. */
  readonly github: Github | null
  /** It has the board's gh server. */
  readonly ghTools: boolean
  /** The project's workflow pushes the branch and opens the pull request once the agent's work is done. */
  readonly boardPr: boolean
}

export const codeTask = (t: CodeTaskFacts): string => {
  const p = t.project
  const key = t.key
  const prs = t.pullRequests
  const gh = prs ? t.github : null
  let s = `You are an agent working on task ${key}-${t.number} ("${t.title}") on the Huntaway board.`
  if (p !== null) s += ` Project: ${p.name} (repository ${p.repo_path}).`
  if (t.worktree_path !== null && t.branch !== null) {
    s +=
      `\n\nYou are in a dedicated git worktree at ${t.worktree_path} on branch \`${t.branch}\`${t.base_branch !== null ? ` (branched from \`${t.base_branch}\`)` : ""}. Make all changes here. ` +
      "When you complete a meaningful unit of work, commit it to this branch with a clear message. " +
      // It pushes the branch for its pull request.
      `Do not ${gh !== null && !t.boardPr ? "merge or switch branches" : "push, merge, or switch branches"} unless asked.`
  }
  // Started from another task's (or pull request's) branch, which it merges into rather than the project's.
  const sf = t.start_from
  if (sf !== null && (sf.type === "task" || sf.type === "pull_request") && t.base_branch !== null && t.branch !== null) {
    const on = sf.type === "task" ? "another task" : "a pull request"
    s +=
      ` This task starts from ${on}: \`${t.base_branch}\` is that ${sf.type === "task" ? "task" : "pull request"}'s branch, so your work is compared with it and your pull request ` +
      "targets it, and its own changes aren't yours to review or redo." +
      // A stack level lands after the one below it; on GitHub, in a stack with its pull request once the board has linked them.
      (sf.type === "task" && t.merges_into === null
        ? t.github_stack !== null
          ? " It lands after that task, on its own, and your pull request is in a stack on GitHub with that task's (GitHub's stacked " +
            "pull requests): once that task is merged, GitHub rebases this branch's own commits onto where that went, force-pushes " +
            "the branch and changes your pull request's base, and the board brings the branch here up to date with that. So don't " +
            "merge this task into that task's branch, and don't change your pull request's base (GitHub refuses to, for one in a " +
            "stack). Commit and push your work as usual."
          : " It lands after that task, on its own: once that task is merged, the board rebases this branch's own commits onto where " +
            "that went, force-pushes the branch (with a lease) and changes your pull request's base, so don't merge this task into that " +
            "task's branch. Commit and push your work as usual, and open your pull request on that task's branch: once both are open " +
            "on GitHub, the board links them into a stack there (GitHub's stacked pull requests) if it can."
        : "")
  }
  // Merging into another task's branch (HA-295).
  const target = t.target
  if (target !== null) {
    const them = `${key}-${target.number}`
    const br = target.branch !== null ? `\`${target.branch}\`` : `${them}'s branch`
    const open = target.branch !== null ? (t.ghTools ? `pr_create with base \`${target.branch}\`` : `\`gh pr create --base ${target.branch}\``) : null
    s +=
      `\n\nThis task merges into ${them} ("${target.title}"): its work goes onto ${them}'s branch ${br} rather than the project's base branch, ` +
      `and reaches the base branch with ${them}'s merge. ` +
      (prs ? `Your pull request targets ${br}${open !== null ? ` (e.g. ${open})` : ""}. ` : "") +
      `${them}'s own changes aren't yours to review or redo.`
  }
  if (gh !== null && t.branch !== null && t.boardPr) {
    s +=
      `\n\nThe repository is on GitHub (${gh.repo}). The board pushes this task's branch and opens its pull request once your work is done, ` +
      "so commit everything, but don't push the branch or open a pull request yourself, even if the project's own instructions (e.g. " +
      "in CLAUDE.md) say to. Once it has one, the board pushes your new commits to it too."
  } else if (gh !== null && t.branch !== null) {
    const br = t.branch
    const base0 = t.base_branch ?? p?.base_branch ?? null
    const base = base0 !== null && base0 !== "" ? base0 : null
    // The repository is named, as gh would pick one from the remotes' fetch URLs.
    const repo = gh.repo
    const open = t.ghTools
      ? `the gh tools' pr_create with repo \`${repo}\`, head \`${br}\`${base !== null ? ` and base \`${base}\`` : ""}`
      : `\`gh pr create --repo ${repo} --head ${br}${base !== null ? ` --base ${base}` : ""}\`, or the gh tools' git_push and pr_create with the same repo, ` +
        "head and base"
    s +=
      `\n\nThe repository is on GitHub (${repo}), so before you finish, open a pull request for this task's work ` +
      "unless the project's own instructions (e.g. in CLAUDE.md) say otherwise:\n" +
      "1. Commit everything.\n" +
      `2. Push the branch: \`git push -u ${gh.remote} ${br}\`${t.ghTools ? ", or the gh tools' git_push if that fails" : ""}.\n` +
      `3. Open the pull request${base !== null ? ` into \`${base}\`` : ""} in ${repo} (${open}), with a title and a body that say what changed and how to ` +
      "try it.\n" +
      "If the branch has a pull request already, push to it instead. Put the pull request's link in your summary. " +
      "A task with no changes on its branch doesn't need one."
  } else if (!prs && t.branch !== null) {
    // Turned off: project instructions that say to open one don't apply.
    s +=
      "\n\nThis project's settings turn off pull requests for its tasks, so don't push this task's branch or open a " +
      "pull request for it unless the user asks, even if the project's own instructions (e.g. in CLAUDE.md) say to."
  }
  s += `\n\n${boardTools}\n\n${askAndFinish("what you did")} You may create follow-up tasks with \`create_task\`.`
  return s
}
