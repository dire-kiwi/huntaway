import { Effect } from "effect"
import type { DiffResult, Project, Task } from "@huntaway/contracts"
import type { GitShape } from "../Git.ts"
import { truncate } from "../paths.ts"
import { taskBase } from "./stacks.ts"
import type { Lookup } from "./stacks.ts"
import { compareRef } from "./upstream.ts"

// A task's changes: what they're compared with (`changesBase`, its start ref) and its diff (huntaway's
// git/worktree/changes.ts; inventory 04, section 2.7).

/**
 * Where a task that started from elsewhere (`start_from`) started, kept in its repository so its changes can be told
 * from what it started on whatever happens to that (a branch deleted once merged, say): the commit its branch was made
 * at, moved on to the branch it's stacked on as the task takes in more of that (see `changesBase`). It goes with the task.
 */
export const startRef = (task: string): string => `refs/huntaway/start/${task}`

/** Drop a deleted task's start ref from `repo`, if it has one. */
export const forgetStart = (g: GitShape, repo: string, task: string) => g.run(repo, ["update-ref", "-d", startRef(task)]).pipe(Effect.ignore)

/** `git merge-base a b` in `dir`, if it has one. */
const mergeBase = (g: GitShape, dir: string, a: string, b: string) =>
  g.run(dir, ["merge-base", a, b]).pipe(
    Effect.map((o) => (o.ok ? o.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  )

/**
 * Move `task`'s start ref on to as much of the branch it's stacked on as its work at `head` in `dir` has taken in (that
 * branch may have more since), while that branch is there, so what it took in of it later isn't counted as its own
 * either, even once it's gone. Only forward, with the old value checked.
 */
export const keepStart = Effect.fnUntraced(function* (g: GitShape, dir: string, task: Task, head: string) {
  const kept = startRef(task.id)
  const at = yield* g.commit(dir, kept)
  const b = task.base_branch
  if (at === null || b === null) return
  const tip = yield* compareRef(g, dir, b)
  const taken = yield* mergeBase(g, dir, tip, head)
  if (taken === null) return
  if (taken !== at && (yield* g.isAncestor(dir, at, taken))) yield* g.run(dir, ["update-ref", kept, taken, at]).pipe(Effect.ignore)
})

/** A task's base branch and where its own work starts (null when not known). */
export interface ChangesBase {
  readonly base: string | null
  readonly start: string | null
}

/** `changesBase` for the task's work at `head` in `dir` (its worktree's HEAD, or its branch when it has no worktree). */
export const changesBaseAt = Effect.fnUntraced(function* (g: GitShape, get: Lookup, dir: string, task: Task, project: Project | null, head: string) {
  const base = yield* taskBase(get, task, project)
  const from: Array<string> = []
  // The task may have started from the base branch's upstream.
  if (base !== null) from.push(yield* compareRef(g, dir, base))
  const sf = task.start_from
  if (sf?.type === "task") {
    if (task.base_branch !== null && task.base_branch !== base) from.push(yield* compareRef(g, dir, task.base_branch))
  } else if (sf?.type === "commit") from.push(sf.commit)
  if (sf !== null) {
    const kept = startRef(task.id)
    yield* keepStart(g, dir, task, head)
    if ((yield* g.commit(dir, kept)) !== null) from.push(kept)
  }
  let start: string | null = null
  for (const rev of from) {
    const mb = yield* mergeBase(g, dir, rev, head)
    if (mb === null) continue
    if (start !== null && !(yield* g.isAncestor(dir, start, mb))) continue
    start = mb
  }
  const out: ChangesBase = { base, start }
  return out
})

/**
 * The base branch a task's changes are compared with (`taskBase`), and where its work starts (only known in the task's
 * own worktree): its merge base with the base branch or, when it started from somewhere else that's later, that. That's
 * where it started (`startRef`) or a commit it started from that the base branch doesn't have, or the branch of the task
 * it's stacked on once that's merged, until it's brought up to date with where that went.
 */
export const changesBase = Effect.fnUntraced(function* (g: GitShape, get: Lookup, dir: string, task: Task, project: Project | null) {
  if (task.worktree_state !== "ready") {
    const out: ChangesBase = { base: yield* taskBase(get, task, project), start: null }
    return out
  }
  return yield* changesBaseAt(g, get, dir, task, project, "HEAD")
})

/** What a review or a summary compares a task's work with. */
export interface WorkScope {
  /** The ref to diff against: its base branch (that or its upstream), or where its own work starts. */
  readonly ref: string | null
  /** The start is later than where the branch left its base, so its pull request's diff has more than its own work. */
  readonly ownStart: boolean
}

/**
 * What a review or a summary of a task's work in its worktree `dir` compares it with: its base branch (that or its
 * upstream, see `compareRef`) or, for a task started from somewhere else (a commit its base branch doesn't have, a task
 * stacked on that's merged since), the commit where the Changes tab has its work start.
 */
export const workScope = Effect.fnUntraced(function* (g: GitShape, get: Lookup, dir: string, task: Task, project: Project | null) {
  const b = yield* taskBase(get, task, project)
  const base = b !== null ? yield* compareRef(g, dir, b) : null
  const plain: WorkScope = { ref: base, ownStart: false }
  if (task.start_from === null) return plain
  const { start } = yield* changesBase(g, get, dir, task, project)
  if (start === null) return plain
  const left = base !== null ? yield* mergeBase(g, dir, base, "HEAD") : null
  const scope: WorkScope = { ref: start, ownStart: left !== start }
  return scope
})

const PATCH_LIMIT = 2_000_000
const DIFF = ["diff", "--no-color", "--no-ext-diff"]
const PATCH = [...DIFF, "--src-prefix=a/", "--dst-prefix=b/"]

/** A diff of the changes in `dir`, the task's worktree or the project's folder, uncommitted and untracked ones too. */
export const dirDiff = Effect.fnUntraced(function* (g: GitShape, get: Lookup, dir: string, task: Task, project: Project | null) {
  const { base, start } = yield* changesBase(g, get, dir, task, project)
  const from = start ?? "HEAD"
  // Marking untracked files intent-to-add would change the index; they're diffed one by one instead.
  const stat = (yield* g.run(dir, [...DIFF, "--stat=200", from])).stdout
  const patch = (yield* g.run(dir, [...PATCH, from])).stdout
  // NUL-separated, so names git would quote (not ASCII, or with a newline) come as they are, and after `--`, so a name
  // starting with `-` isn't taken for an option.
  const untracked = (yield* g.ok(dir, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter((f) => f !== "")
  let untrackedPatch = ""
  for (const f of untracked.slice(0, 50)) {
    // It exits 1 when the files differ, which they do.
    untrackedPatch += (yield* g.run(dir, [...PATCH, "--no-index", "--", "/dev/null", f])).stdout
  }
  const commits = start !== null ? (yield* g.run(dir, ["log", "--oneline", `${start}..HEAD`])).stdout : ""
  const out: DiffResult = { available: true, dir, base, merge_base: start, commits, stat, patch: truncate(patch + untrackedPatch, PATCH_LIMIT), untracked }
  return out
})

/** The committed work on a task's branch with no worktree, from where it left its base branch. */
export const branchDiff = Effect.fnUntraced(function* (g: GitShape, get: Lookup, repo: string, task: Task, project: Project | null) {
  const branch = task.branch
  if (branch === null || branch === "") return { available: false, reason: "the task has no worktree or branch" } satisfies DiffResult
  const head = `refs/heads/${branch}`
  if (!(yield* g.run(repo, ["rev-parse", "--verify", "--quiet", head])).ok) {
    return { available: false, reason: `the task has no worktree, and its branch ${branch} is gone` } satisfies DiffResult
  }
  const { base, start } = yield* changesBaseAt(g, get, repo, task, project, head)
  const from = start ?? head
  const stat = (yield* g.run(repo, [...DIFF, "--stat=200", from, head])).stdout
  const patch = (yield* g.run(repo, [...PATCH, from, head])).stdout
  const commits = start !== null ? (yield* g.run(repo, ["log", "--oneline", `${start}..${head}`])).stdout : ""
  const out: DiffResult = { available: true, dir: repo, base, merge_base: start, commits, stat, patch: truncate(patch, PATCH_LIMIT), untracked: [], branch }
  return out
})
