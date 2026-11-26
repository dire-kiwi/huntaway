import { Context, Effect, Layer, Ref } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { ProjectId } from "@huntaway/contracts"

// What a set of tasks across repositories reads of each project's repository (HE-117): which repository it is, and
// every local and remote branch of it, which the set's one branch name keeps clear of. The tasks area sits above git, so the git area registers the reader here when its layer
// is built (`branchReader` in git/branchNames.ts), as the merge area registers `MergeFacts`.

/** What a set reads of a project's repository. */
export interface RepoFacts {
  /** The repository, as one path for every folder and worktree of it (its common git folder, canonical). */
  readonly repository: string
  /** Its branch names, local and remote (without the remote). */
  readonly branches: ReadonlyArray<string>
}

/** A project's repository's facts, or why they can't be read. */
export type BranchReader = (project: ProjectId) => Effect.Effect<RepoFacts, Invalid>

export interface RepoBranchesShape {
  /** The git area's reader, from now on. */
  readonly register: (reader: BranchReader) => Effect.Effect<void>
  /** `project`'s repository and its branch names (`Invalid` when they can't be read, or no reader is registered). */
  readonly read: (project: ProjectId) => Effect.Effect<RepoFacts, Invalid>
}

export class RepoBranches extends Context.Service<RepoBranches, RepoBranchesShape>()("huntaway-server/tasks/RepoBranches") {
  static readonly layer = Layer.effect(
    RepoBranches,
    Effect.gen(function* () {
      const reader = yield* Ref.make<BranchReader | null>(null)
      return RepoBranches.of({
        register: (r) => Ref.set(reader, r),
        read: (project) =>
          Effect.flatMap(Ref.get(reader), (r) =>
            r === null ? Effect.fail(new Invalid({ field: "also_in", reason: "this server can't read the repositories' branches" })) : r(project),
          ),
      })
    }),
  )
}
