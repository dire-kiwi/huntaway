import { Effect } from "effect"
import type { Project, Task } from "@huntaway/contracts"
import type { GitShape } from "../git/Git.ts"
import type { TaskBaseShape } from "../git/TaskBase.ts"

// What reviews and summaries read of a task's worktree (huntaway's review.ts `rev_parse` and the start's git reads):
// the commit, where its own work starts, and whether the branch has no commits of its own.

/** A commit `rev` names in `dir`, or null. */
export const revParse = (git: GitShape, dir: string, rev: string): Effect.Effect<string | null> =>
  git.run(dir, ["rev-parse", "--verify", rev]).pipe(
    Effect.map((o) => (o.ok && o.stdout.trim() !== "" ? o.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  )

/** Where the work to review or summarise is. */
export interface Work {
  /** The ref its changes are diffed against (`TaskBase.workScope`). */
  readonly base: string | null
  /** It starts later than where the branch left its base branch, which its pull request's diff would include. */
  readonly ownStart: boolean
  /** The branch has no commits of its own (HEAD is where it left its base): the agent's changes, if any, are elsewhere. */
  readonly elsewhere: boolean
}

export const readWork = Effect.fnUntraced(function* (git: GitShape, base: TaskBaseShape, dir: string, task: Task, project: Project, head: string) {
  const scope = yield* base.workScope(dir, task, project)
  let elsewhere = false
  if (scope.ref !== null) {
    const o = yield* git.run(dir, ["merge-base", scope.ref, "HEAD"]).pipe(Effect.orElseSucceed(() => null))
    // The agent may have made its changes somewhere else, such as in another repository.
    elsewhere = o !== null && o.ok && o.stdout.trim() === head
  }
  const work: Work = { base: scope.ref, ownStart: scope.ownStart, elsewhere }
  return work
})
