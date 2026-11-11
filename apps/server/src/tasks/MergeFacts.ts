import { Context, Effect, Layer, Ref } from "effect"
import type { Task, TaskPatch } from "@huntaway/contracts"
import type { PrApproval } from "./decide.ts"

// What `Tasks.update` needs from git and GitHub to decide a change (docs/plan/06-server.md, Tasks and Merge; huntaway's
// api/tasks.ts `has_work_to_merge`, `pr_approval_required`/`pr_approved`, the start ref `retarget_fields` keeps, and
// whether a failed worktree's folder is there): whether a task moved to Ready for merge has work to merge and the
// approving review its project asks for, and where its branch started. The tasks area sits above git and GitHub, whose
// services need `Tasks`, so it can't call them: the merge area registers the reader here when its layer is built
// (`Merges.registered`), as the areas below `runs/` register with `AgentRequests`. Until then (and in tests that build
// no merge area) the facts are the old defaults with no repository: no work, no folder, no start, no approval asked.

/** What git and GitHub say of a task, for one change. */
export interface GitFacts {
  /** Git finds work of its own to merge (or can't tell). */
  readonly gitWork: boolean
  /** Its worktree's folder is there. */
  readonly worktreeFolderExists: boolean
  /** Where its own work starts (`refs/huntaway/start/<id>`), if it has a branch. */
  readonly startCommit: string | null
  /** Whether its pull request needs, and has, an approving review before a merge. */
  readonly prApproval: PrApproval
}

/** The facts with nothing read. */
export const NO_GIT_FACTS: GitFacts = { gitWork: false, worktreeFolderExists: false, startCommit: null, prApproval: { _tag: "NotRequired" } }

/** Reads the facts a change of `task` by `patch` needs (only those; the others stay as `NO_GIT_FACTS`). */
export type GitFactsReader = (task: Task, patch: TaskPatch) => Effect.Effect<GitFacts>

/** Whether a change needs anything read from git or GitHub, before the task's lock is taken. */
export const needsGitFacts = (task: Task, patch: TaskPatch): boolean =>
  (patch.status === "ready_for_merge" && task.status !== "ready_for_merge" && task.kind === "task") ||
  (patch.merges_into !== undefined && task.branch !== null) ||
  (task.worktree_state === "error" && (patch.use_worktree !== undefined || patch.base_branch !== undefined || patch.start_from !== undefined))

export interface MergeFactsShape {
  /** The merge area's reader, from now on. */
  readonly register: (reader: GitFactsReader) => Effect.Effect<void>
  /** The facts a change of `task` by `patch` needs (`NO_GIT_FACTS` when it needs none, or nothing is registered). */
  readonly read: (task: Task, patch: TaskPatch) => Effect.Effect<GitFacts>
}

export class MergeFacts extends Context.Service<MergeFacts, MergeFactsShape>()("huntaway-server/tasks/MergeFacts") {
  static readonly layer = Layer.effect(
    MergeFacts,
    Effect.gen(function* () {
      const reader = yield* Ref.make<GitFactsReader | null>(null)
      return MergeFacts.of({
        register: (r) => Ref.set(reader, r),
        read: (task, patch) =>
          Effect.flatMap(Ref.get(reader), (r) => (r === null || !needsGitFacts(task, patch) ? Effect.succeed(NO_GIT_FACTS) : r(task, patch))),
      })
    }),
  )
}
