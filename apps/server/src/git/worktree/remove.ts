import { Effect } from "effect"
import type { FileSystem } from "effect"
import type { Project } from "@huntaway/contracts"
import type { GitShape } from "../Git.ts"
import { pathStartsWith, samePath } from "../paths.ts"
import { fail, fromGit, WorktreeFailed } from "./failed.ts"

// What removing a worktree checks first (huntaway's git/worktree/remove.ts; inventory 04, sections 2.6 and 9: removal
// never loses work).

/**
 * Whether `wt` may be removed by hand when git won't remove it as a worktree: a folder inside the project's worktrees
 * folder that isn't the repository (or another main checkout), so a stray folder there, or a misconfigured worktrees
 * folder, can't cost work kept elsewhere.
 */
export const removableByHand = Effect.fnUntraced(function* (g: GitShape, project: Pick<Project, "worktrees_root">, repo: string, wt: string) {
  const canon = (p: string) => Effect.map(g.canonicalize(p), (c) => c ?? p)
  const root = yield* canon(project.worktrees_root)
  const wtC = yield* canon(wt)
  const repoC = yield* canon(repo)
  if (!pathStartsWith(wtC, root) || samePath(wtC, root) || samePath(wtC, repoC)) return false
  // A main checkout's git dir is its own `.git`; a linked worktree's is under the repository's.
  const o = yield* g.run(wtC, ["rev-parse", "--absolute-git-dir"]).pipe(Effect.orElseSucceed(() => null))
  if (o !== null && o.ok) return !o.stdout.trim().endsWith("/.git")
  return true
})

/** The parts of a NUL-separated list, without the empty one at its end. */
const splitNul = (s: string) => {
  const parts = s.split("\0")
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
  return parts
}

/** The object id git would give file `path` (relative to `wt`), read through `--stdin-paths`. */
const hashObject = Effect.fnUntraced(function* (g: GitShape, wt: string, path: string) {
  const out = yield* g.run(wt, ["hash-object", "--stdin-paths"], { stdin: `${path}\n` }).pipe(Effect.mapError(fromGit))
  if (!out.ok) return yield* fail(`git hash-object -- ${path} failed: ${out.stderr.trim()}`)
  return out.stdout.trim()
})

/**
 * What in worktree `wt` isn't committed (`git status --porcelain`, trimmed), whatever the repository's settings hide:
 * every untracked file, every submodule change, and changes to tracked files marked assume-unchanged or skip-worktree.
 * Ignored files don't count. "" when nothing.
 */
export const uncommitted = Effect.fnUntraced(function* (g: GitShape, fs: FileSystem.FileSystem, wt: string) {
  const status = yield* g.ok(wt, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).pipe(Effect.mapError(fromGit))
  const out = status
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  // git status skips marked files, so they're compared with the index here: content and, with core.fileMode (git's
  // default), the executable bit. One that isn't on disk (left out of a sparse checkout, say) has nothing to lose.
  const index = yield* g.ok(wt, ["ls-files", "-v", "-s", "-z"]).pipe(Effect.mapError(fromGit))
  const fileMode = yield* g.run(wt, ["config", "--type=bool", "core.fileMode"]).pipe(
    Effect.map((o) => o.stdout.trim() !== "false"),
    Effect.orElseSucceed(() => true),
  )
  for (const entry of splitNul(index)) {
    // "<tag> <mode> <object> <stage>\t<path>"; a lowercase tag is assume-unchanged, S skip-worktree.
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    const [tag, mode, object] = entry.slice(0, tab).split(" ")
    const path = entry.slice(tab + 1)
    if (tag === undefined || mode === undefined || object === undefined) continue
    const assumed = /^[a-z]+$/.test(tag)
    if (!(assumed || tag === "S")) continue
    const file = yield* fs.lstat(`${wt}/${path}`).pipe(
      Effect.map((info): FileSystem.File.Info | null => info),
      Effect.catch((e) => (e.reason._tag === "NotFound" ? Effect.succeed(null) : fail(`checking ${path}: ${e.message}`))),
    )
    if (file === null) continue
    // Only a regular file is compared; anything else counts as changed.
    const executable = (file.mode & 0o100) !== 0
    const same =
      file.type === "File" &&
      ["100644", "100755"].includes(mode) &&
      (!fileMode || executable === (mode === "100755")) &&
      (yield* hashObject(g, wt, path)) === object
    if (!same) out.push(` M ${path} (marked ${assumed ? "assume-unchanged" : "skip-worktree"})`)
  }
  return out.join("\n")
})

/**
 * How many commits a worktree's HEAD has that no branch, remote branch or tag has: a detached HEAD's, which nothing but
 * the worktree keeps (they'd be garbage once it's gone).
 */
export const stray = Effect.fnUntraced(function* (g: GitShape, wt: string) {
  const o = yield* g.run(wt, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes", "--tags"]).pipe(Effect.mapError(fromGit))
  if (!o.ok) return yield* fail(`git rev-list failed: ${o.stderr.trim()}`)
  const t = o.stdout.trim()
  if (!/^\d+$/.test(t)) return yield* fail("invalid digit found in string")
  return Number(t)
})

/** Fails if worktree `wt` has commits on no branch (see `stray`), which removing it would lose. */
export const noStrays = Effect.fnUntraced(function* (g: GitShape, wt: string) {
  const n = yield* stray(g, wt).pipe(Effect.mapError((e) => new WorktreeFailed({ reason: `checking the worktree for commits on no branch: ${e.reason}` })))
  return n > 0 ? yield* fail(`worktree has ${n} commit${n === 1 ? "" : "s"} on no branch (a detached HEAD), which would be lost`) : undefined
})
