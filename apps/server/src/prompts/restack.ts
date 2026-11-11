// What a stack level's agent is asked when the board could not restack its branch itself after the level below it was
// merged (huntaway's git/worktree/restack.ts). Plan task 4.8 (`Restack`).

export interface RestackFacts {
  /** The key of the task it lands after, or "The task this one lands after" once that is gone. */
  readonly them: string
  /** Where it goes now. */
  readonly onto: string
  readonly branch: string
  /** Why the board could not. */
  readonly conflict: string
  /** Where this task's own work starts (`refs/huntaway/start/<task id>`). */
  readonly startRef: string
  /** Its pull request is in a stack on GitHub. */
  readonly githubStack: boolean
}

export const restack = (t: RestackFacts): string =>
  `${t.them}, which this task lands after, was merged, so this task now goes to \`${t.onto}\`. The board couldn't restack its ` +
  `branch \`${t.branch}\` onto \`${t.onto}\` itself: ${t.conflict}. Do it yourself: fetch, rebase this task's own commits onto ` +
  `\`${t.onto}\` (as it is on the remote), without ${t.them}'s (\`git rebase --onto <${t.onto}> ${t.startRef}\`: \`${t.startRef}\` ` +
  `is where this task's own work starts), resolve any conflicts, check the work, then push the branch with ` +
  `\`git push --force-with-lease\`. ${
    t.githubStack
      ? "Its pull request is in a stack on GitHub, which changes its base itself (and refuses to have it changed)."
      : `If it has a pull request, change its base to \`${t.onto}\`.`
  } Don't merge it.`
