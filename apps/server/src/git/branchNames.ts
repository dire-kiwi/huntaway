import { Effect, Layer, Option } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { ProjectId } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { RepoBranches } from "../tasks/RepoBranches.ts"
import { Git } from "./Git.ts"
import { expandHome, lines } from "./paths.ts"

// A repository's branch names, for a set of tasks across repositories to keep clear of (HE-117; tasks/sets.ts
// `freeBranchName`): its local branches and its remote-tracking ones, without their remote's name.

/**
 * The branch names in `refs` (full ref names, as `git for-each-ref` prints them) of a repository with remotes
 * `remotes`: `refs/heads/<name>`, and `refs/remotes/<remote>/<name>` (the longest remote that fits; its `HEAD` left out).
 */
export const branchNamesOf = (refs: ReadonlyArray<string>, remotes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const byLength = remotes.toSorted((a, b) => b.length - a.length)
  const out = new Set<string>()
  for (const ref of refs) {
    if (ref.startsWith("refs/heads/")) out.add(ref.slice("refs/heads/".length))
    else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length)
      const remote = byLength.find((r) => rest.startsWith(`${r}/`))
      const name = remote === undefined ? rest.slice(rest.indexOf("/") + 1) : rest.slice(remote.length + 1)
      if (name !== "" && name !== "HEAD" && name !== rest) out.add(name)
    }
  }
  return [...out]
}

/** Registers the reader of a project's branch names with the tasks area (`RepoBranches`). */
export const branchReader = Layer.effectDiscard(
  Effect.gen(function* () {
    const branches = yield* RepoBranches
    const projects = yield* ProjectRepo
    const g = yield* Git
    const config = yield* ServerConfig
    yield* branches.register(
      Effect.fnUntraced(function* (id: ProjectId) {
        const project = Option.getOrNull(yield* projects.get(id))
        if (project === null) return yield* new Invalid({ field: "also_in", reason: `project ${id} isn't there` })
        const dir = expandHome(project.repo_path, config.home)
        const cant = (why: string) => new Invalid({ field: "also_in", reason: `can't read the branches of ${project.name} (${project.repo_path}): ${why}` })
        const read = (args: ReadonlyArray<string>) => g.ok(dir, args).pipe(Effect.mapError((e) => cant(e.reason)))
        if (!(yield* g.isRepo(dir))) return yield* cant("it isn't a git repository")
        const refs = lines(yield* read(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
        return branchNamesOf(refs, lines(yield* read(["remote"])))
      }),
    )
  }),
)
