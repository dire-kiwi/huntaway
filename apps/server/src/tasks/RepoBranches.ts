import { Context, Effect, Layer, Ref } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { ProjectId } from "@huntaway/contracts"

// The branch names a set of tasks across repositories has to keep clear of (HE-117): every local and remote branch of
// each project's repository. The tasks area sits above git, so the git area registers the reader here when its layer
// is built (`branchReader` in git/branchNames.ts), as the merge area registers `MergeFacts`.

/** A project's repository's branch names, local and remote (without the remote), or why they can't be read. */
export type BranchReader = (project: ProjectId) => Effect.Effect<ReadonlyArray<string>, Invalid>

export interface RepoBranchesShape {
  /** The git area's reader, from now on. */
  readonly register: (reader: BranchReader) => Effect.Effect<void>
  /** The branch names of `project`'s repository (`Invalid` when it can't be read, or no reader is registered). */
  readonly taken: (project: ProjectId) => Effect.Effect<ReadonlyArray<string>, Invalid>
}

export class RepoBranches extends Context.Service<RepoBranches, RepoBranchesShape>()("huntaway-server/tasks/RepoBranches") {
  static readonly layer = Layer.effect(
    RepoBranches,
    Effect.gen(function* () {
      const reader = yield* Ref.make<BranchReader | null>(null)
      return RepoBranches.of({
        register: (r) => Ref.set(reader, r),
        taken: (project) =>
          Effect.flatMap(Ref.get(reader), (r) =>
            r === null ? Effect.fail(new Invalid({ field: "also_in", reason: "this server can't read the repositories' branches" })) : r(project),
          ),
      })
    }),
  )
}
