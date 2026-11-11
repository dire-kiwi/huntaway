import { Effect } from "effect"
import type { FileSystem } from "effect"
import { pathStartsWith } from "./checks.ts"

/**
 * Remove a deleted project's or profile's folder in the data folder (the old `remove_unused_dir`), unless something
 * still on this host lies inside it: a repository, a worktree, or a folder a project or task points at (`used`).
 * Through a symbolic link a used path that does not exist yet can only match the folder as it is named, so both the
 * folder's real path and its name are compared. Never fails: what cannot be removed is logged and left.
 */
export const removeUnusedDir = (fs: FileSystem.FileSystem, dir: string, used: ReadonlyArray<string>, what: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(dir).pipe(Effect.option)
    if (info._tag === "None" || info.value.type !== "Directory") return
    const canonical = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => p))
    const roots = [yield* canonical(dir), dir]
    for (const p of used) {
      if (!p.startsWith("/")) continue
      const real = yield* canonical(p)
      if (roots.some((root) => pathStartsWith(real, root) || pathStartsWith(p, root))) {
        yield* Effect.logWarning(`keeping ${dir} after deleting its ${what}: ${p} is in it`)
        return
      }
    }
    yield* fs.remove(dir, { recursive: true }).pipe(Effect.catch((e) => Effect.logWarning(`removing ${dir} after deleting its ${what}: ${e.message}`)))
  })
