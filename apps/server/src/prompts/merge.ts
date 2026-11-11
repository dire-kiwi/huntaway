// What the agent of a task moved to "Ready for merge" is asked when its turn in the merge queue comes (huntaway's
// agent/runner/merge.ts request_merge, into_merge, stacked_merge and STEP_OUT). Plan task 4.7 (`Merges`); the stack
// sentences are plan task 4.8.

/**
 * Other tasks wait to merge while this one does, so a merge that turns out to need changes steps out of the queue to
 * make them.
 */
export const STEP_OUT =
  "Tasks queued to merge after this one wait while you merge it. Bringing the branch up to date, resolving " +
  "simple conflicts, waiting for checks and re-running flaky ones are part of merging. But if the merge needs changes to this task's " +
  "work (checks that fail because of it, review comments to address, conflicts that need more than a simple resolution), step out of " +
  "the merge queue first so the next task can merge meanwhile: call `update_task` to set this task's status to `in_progress`, with " +
  "`remerge` true. Then make the changes, check them, commit and push, and end your turn without merging: the board puts the task " +
  "back at the end of the merge queue and asks you to merge again when its turn comes."

/** How the agent says it's merged, unless the project's workflow moves the task to Done (`workflowMergeFinish`). */
export const MERGE_DONE = "Once it is merged, call `update_task` to set this task's status to `done`."

/** "Merge branch `x` into `main`", or into the base branch when it is not known. */
export const mergeWhatInto = (branch: string | null, base: string | null): string => {
  const into = base !== null ? `\`${base}\`` : "the base branch"
  return branch !== null ? `Merge branch \`${branch}\` into ${into}` : `Merge this task's work into ${into}`
}

export interface MergeRequestFacts {
  /** The user approved the merge (it waited for their approval). */
  readonly approved: boolean
  /** `mergeWhatInto`. */
  readonly what: string
  /** What `mergeInto*` or `stacked*` say of where it merges, or "". */
  readonly stacked: string
  /** The workflow's Ready for merge prompt, the project's merge prompt, or `DEFAULT_MERGE`. */
  readonly instructions: string
  /** `workflowMergeFinish`, or `MERGE_DONE`. */
  readonly merged: string
}

/** The request; `mergeStackRun`, `mergeIncoming` or `mergeMergedInto`, and `mergeCarries` follow it as they apply. */
export const mergeRequest = (t: MergeRequestFacts): string =>
  `The user moved this task to "Ready for merge".${t.approved ? " The user approved the merge." : ""} ${t.what}.${t.stacked}\n\n${t.instructions}\n\nIf you can't merge, call \`request_user_input\` ` +
  `explaining why. ${t.merged}\n\n${STEP_OUT}`

/** A level of a stack merging as one run, with `above` levels still to merge after it. */
export const mergeStackRun = (above: number): string =>
  ` The user is merging this task's whole stack at once: ${above === 1 ? "the level" : `the ${above} levels`} above it ` +
  `merge${above === 1 ? "s" : ""} right after this one, and nothing else merges in between, so don't wait on anything that isn't needed ` +
  "for this merge. If you step out of the merge queue, they wait for this task and the rest of the queue goes ahead of them."

/** A task as `mergeIncoming` lists it: "WEB-3 (Fix it, in review)". */
export const mergeListed = (key: string, title: string, status: string): string => `${key} (${title}, ${status.replaceAll("_", " ")})`

/** Tasks that merge into this one's branch and aren't done yet, each `mergeListed`. */
export const mergeIncoming = (listed: ReadonlyArray<string>): string =>
  ` Other tasks merge into this one's branch, and some of them aren't done yet: ${listed.join("; ")}. Ask the user (with \`request_user_input\`) ` +
  "whether to merge without them before you merge: if you do, they go where this task goes. Bring the branch up to date first (pull it if " +
  "it's on the remote, where their pull requests may have been merged)."

/** Tasks were merged into this one's branch, and all of them are done. */
export const mergeMergedInto =
  " Other tasks were merged into this one's branch: bring it up to date first (pull it if it's on the remote, where their pull requests were merged)."

/**
 * Its branch may still have the commits of a task it built on that was closed without being merged: `key` that task's
 * key (null once deleted), `commit` where this task's own work starts, `base` where it merges.
 */
export const mergeCarries = (t: {
  readonly key: string | null
  readonly commit: string | null
  readonly base: string | null
  readonly branch: string
}): string => {
  const who = t.key ?? "a task that was deleted without being merged"
  const from = t.commit !== null && t.commit !== "" ? `, before commit \`${t.commit}\` (where this task's own work starts)` : ""
  const onto = t.base ?? "<base branch>"
  return (
    ` This task's branch started on top of ${who}'s, which was closed without being merged, so it may still have ${who}'s commits ` +
    `(and those of tasks merged into it)${from}: check with \`git log ${onto}..${t.branch}\`. If it does, before merging ask the user ` +
    `(with \`request_user_input\`, unless they've already said in this conversation) whether to keep them or leave them out` +
    (t.commit !== null && t.commit !== "" ? ` (\`git rebase --onto ${onto} ${t.commit}\`, then force-push the branch).` : ", rebasing them out of the branch.")
  )
}

/** It merges into `them`, which is merged already: into `base`, where that went. */
export const mergeIntoMerged = (them: string, base: string | null): string => {
  const shown = base !== null ? `\`${base}\`` : "its base branch"
  return (
    ` This task merges into ${them}, which is merged already, so merge it into ${shown}, where ${them} went: if its pull request ` +
    `targets ${them}'s branch, change its base to ${shown} first, and bring the branch up to date with ${shown} (rebasing it onto ${shown} ` +
    `without ${them}'s commits if they were squashed or rebased).`
  )
}

/** It merges into `them`, which is open, on its branch. */
export const mergeIntoOpen = (them: string, title: string, status: string, branch: string): string =>
  ` This task merges into ${them} ("${title}", ${status.replaceAll("_", " ")}): its work goes onto ${them}'s branch \`${branch}\`, ` +
  `to reach the project's base branch with ${them}'s merge. If its pull request targets another branch, change its base to \`${branch}\` first.`

/** A stack level whose branch the board (or GitHub, `githubStack`) restacked onto `base` once `them` was merged. */
export const stackedRestacked = (them: string, base: string, githubStack: boolean): string =>
  ` This task landed after ${them}, which is merged: its branch was restacked onto \`${base}\`${githubStack ? " (by GitHub: its pull request is in a stack there, so merge it with pr_merge, which uses GitHub's merge-async API for that)" : ""}, and its pull request targets that now (change its base if it doesn't).`

/** A stack level on `them`'s branch `branch`, which is merged already: into `base`, where that went. */
export const stackedOnMerged = (them: string, base: string | null, branch: string): string => {
  const shown = base !== null ? `\`${base}\`` : "its base branch"
  return (
    ` This task lands after ${them}, which is merged already, so merge it into ${shown} instead of ${them}'s branch \`${branch}\`: ` +
    `if its pull request still targets \`${branch}\`, change its base to ${shown} first, and bring the branch up to date with ` +
    `${shown} (rebasing it onto ${shown} without ${them}'s commits if they were squashed or rebased).`
  )
}

/** A task started from pull request `number`'s branch `branch`. */
export const stackedOnPullRequest = (number: number, branch: string): string =>
  ` This task started from pull request #${number}'s branch \`${branch}\`. If that pull request is merged by now, merge this one ` +
  `into where it went instead, changing this task's pull request's base first and bringing its branch up to date.`
