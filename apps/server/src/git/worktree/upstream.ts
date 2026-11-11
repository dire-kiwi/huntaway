import { Effect } from "effect"
import type { GitShape } from "../Git.ts"
import type { GitHubAccessShape } from "../GitHubAccess.ts"
import { lines, plural } from "../paths.ts"
import { fail } from "./failed.ts"
import type { WorktreeFailed } from "./failed.ts"

// The branch a base branch follows, fetching it, and where a new task branch starts from it (huntaway's
// git/worktree/upstream.ts; inventory 04, section 2.3). Functions over `Git` for `TaskBase` and `Worktrees`.

/** The branch a base branch follows. */
export interface Upstream {
  readonly remote: string
  /** Its ref on the remote (`refs/heads/master`). */
  readonly merge: string
  /** Where it's fetched to (`refs/remotes/origin/master`), or a local branch for an upstream in the repository itself (remote `.`). */
  readonly tracking: string
}

/** Its short name, e.g. `origin/master`. */
export const upstreamName = (up: Upstream): string => {
  if (up.tracking.startsWith("refs/remotes/")) return up.tracking.slice("refs/remotes/".length)
  if (up.tracking.startsWith("refs/heads/")) return up.tracking.slice("refs/heads/".length)
  return up.tracking
}

/** The repository's remotes. */
const remotes = (g: GitShape, repo: string) =>
  g.ok(repo, ["remote"]).pipe(
    Effect.map((out) =>
      lines(out)
        .map((r) => r.trim())
        .filter((r) => r !== ""),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )

/** The remote and branch `name` stands for when it's a remote's name, a slash and a branch. */
export const remoteBranch = Effect.fnUntraced(function* (g: GitShape, repo: string, name: string) {
  const i = name.indexOf("/")
  if (i <= 0 || i === name.length - 1) return null
  const remote = name.slice(0, i)
  const rest = name.slice(i + 1)
  return (yield* remotes(g, repo)).includes(remote) ? ([remote, rest] as const) : null
})

/**
 * The branch base branch `base` follows: its upstream or, for one without (pushed without `-u`, say, or only on the
 * remote), the branch of the same name on `origin` (or the only remote), if that was fetched before or there's no local
 * branch. A remote's branch named with it (`upstream/feature`, with no local branch of that name) is that branch on that
 * remote, fetched or not. None for a tag, a commit or `HEAD`.
 */
export const upstream = Effect.fnUntraced(function* (g: GitShape, repo: string, base: string) {
  const local = `refs/heads/${base}`
  const hasLocal = (yield* g.commit(repo, local)) !== null
  if (!hasLocal) {
    const rb = yield* remoteBranch(g, repo, base)
    if (rb !== null) {
      const found: Upstream = { tracking: `refs/remotes/${base}`, remote: rb[0], merge: `refs/heads/${rb[1]}` }
      return found
    }
  }
  if (hasLocal) {
    const config = (key: string) =>
      g.run(repo, ["config", `branch.${base}.${key}`]).pipe(
        Effect.map((o) => o.stdout.trim()),
        Effect.orElseSucceed(() => ""),
      )
    const remote = yield* config("remote")
    const merge = yield* config("merge")
    if (remote !== "" && merge !== "") {
      const tracking = yield* g.ok(repo, ["for-each-ref", "--format=%(upstream)", local]).pipe(
        Effect.map((s) => s.trim()),
        Effect.orElseSucceed(() => ""),
      )
      if (tracking === "") return null
      const found: Upstream = { remote, merge, tracking }
      return found
    }
  } else if (base === "HEAD" || (yield* g.commit(repo, base)) !== null) return null
  const all = yield* remotes(g, repo)
  const remote = all.includes("origin") ? "origin" : all.length === 1 ? (all[0] ?? null) : null
  if (remote === null) return null
  const tracking = `refs/remotes/${remote}/${base}`
  if (hasLocal && (yield* g.commit(repo, tracking)) === null) return null
  const found: Upstream = { remote, merge: local, tracking }
  return found
})

/** How long a fetch may take, authenticating included. */
const FETCH_LIMIT = "60 seconds"

/**
 * `git fetch --quiet --no-tags <remote> <what…>`, authenticated as `account` for an HTTPS GitHub remote
 * (`GitHubAccess.fetchEnv`), stopped after a minute.
 */
const fetchFrom = (
  g: GitShape,
  gh: GitHubAccessShape,
  repo: string,
  remote: string,
  what: ReadonlyArray<string>,
  account: string | null,
  failed: string,
  options: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const url = yield* g.run(repo, ["remote", "get-url", remote]).pipe(
      Effect.map((o) => (o.ok ? o.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    )
    const env = url === "" ? {} : yield* gh.fetchEnv(repo, account, url)
    const out = yield* g.run(repo, ["fetch", "--quiet", "--no-tags", ...options, remote, ...what], { env, timeout: FETCH_LIMIT })
    return out.ok ? undefined : yield* fail(`${failed} failed: ${out.stderr.trim()}`)
  }).pipe(
    Effect.timeoutOrElse({ duration: FETCH_LIMIT, orElse: () => fail(`git fetch ${remote} timed out`) }),
    Effect.catchTag("GitFailed", (e) =>
      fail(e.code === null && e.reason.startsWith("timed out") ? `git fetch ${remote} timed out` : `${failed} failed: ${e.reason}`),
    ),
  )

/** Fetch `up` (unless it's in the repository itself). */
export const fetchUpstream = (g: GitShape, gh: GitHubAccessShape, repo: string, up: Upstream, account: string | null): Effect.Effect<void, WorktreeFailed> =>
  up.remote === "." ? Effect.void : fetchFrom(g, gh, repo, up.remote, [`+${up.merge}:${up.tracking}`], account, `git fetch ${up.remote}`)

/** Fetch base branch `base`'s upstream (see `upstream`), returning its name (e.g. `origin/master`), or null when it has none. */
export const fetchBase = Effect.fnUntraced(function* (g: GitShape, gh: GitHubAccessShape, repo: string, base: string, account: string | null) {
  const up = yield* upstream(g, repo, base)
  if (up === null) return null
  yield* fetchUpstream(g, gh, repo, up, account)
  return upstreamName(up)
})

/**
 * Fetch commit `sha` (in full) from `remote`, as a pull request's head or a commit a task starts from, so it's in the
 * repository; the branch made from it keeps it.
 */
export const fetchCommit = Effect.fnUntraced(function* (g: GitShape, gh: GitHubAccessShape, repo: string, remote: string, sha: string, account: string | null) {
  if ((yield* g.commit(repo, sha)) !== null) return
  yield* fetchFrom(g, gh, repo, remote, [sha], account, `git fetch ${remote} ${sha}`, ["--no-write-fetch-head"])
})

/**
 * What a task branched from base branch `base` is compared with to find its own work: the newer of the local branch and
 * its upstream as last fetched, as `startPoint` picks (the upstream when they've diverged), without fetching. The
 * upstream when there's no local branch, and `base` as is when it has no upstream or that was never fetched.
 */
export const compareRef = Effect.fnUntraced(function* (g: GitShape, repo: string, base: string) {
  const up = yield* upstream(g, repo, base)
  if (up === null) return base
  const theirs = yield* g.commit(repo, up.tracking)
  if (theirs === null) return base
  const ours = yield* g.commit(repo, `refs/heads/${base}`)
  if (ours !== null && (yield* g.isAncestor(repo, theirs, ours))) return base
  return upstreamName(up)
})

/** A thread event: level, text and detail. */
export type Note = readonly ["info" | "warn" | "error", string, string | null]

/** Where a new task branch starts. */
export interface Start {
  /** The commit, or `base` as given when it has no upstream. */
  readonly rev: string
  /** What it is, for the task log: `master` or `origin/master`. */
  readonly from: string
  readonly notes: ReadonlyArray<Note>
}

/**
 * Where a task branch from base branch `base` starts: the newer of the local branch and its upstream (fetched first), so
 * it starts from the latest commit even when the local branch is behind and can't be fast-forwarded (it's checked out
 * with changes in the way, say). The local branch is fast-forwarded when it can be. When the two have diverged it's the
 * upstream, which is where the task's pull request goes; when the local branch is ahead (with commits that aren't
 * pushed), it's the local branch. If the fetch fails, it goes by the last one.
 */
export const startPoint = Effect.fnUntraced(function* (g: GitShape, gh: GitHubAccessShape, repo: string, base: string, account: string | null) {
  const notes: Array<Note> = []
  const start = (rev: string, from: string): Start => ({ rev, from, notes })
  const up = yield* upstream(g, repo, base)
  if (up === null) return start(base, base)
  const name = upstreamName(up)
  const fetched = yield* Effect.result(fetchUpstream(g, gh, repo, up, account))
  if (fetched._tag === "Failure") notes.push(["warn", `Could not fetch ${name}; branching from the copy fetched before`, fetched.failure.reason])
  const theirs = yield* g.commit(repo, up.tracking)
  if (theirs === null) return start(base, base)
  const local = `refs/heads/${base}`
  const ours = yield* g.commit(repo, local)
  if (ours === null) return start(theirs, name)
  if (yield* g.isAncestor(repo, theirs, ours)) return start(ours, base)
  const count = (range: string) =>
    g.ok(repo, ["rev-list", "--count", range]).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => "?"),
    )
  if (!(yield* g.isAncestor(repo, ours, theirs))) {
    const n = yield* count(`${theirs}..${ours}`)
    notes.push(["warn", `${base} has diverged from ${name}; branching from ${name}, without the ${n} commit${plural(n)} only ${base} has`, null])
    return start(theirs, name)
  }
  const n = yield* count(`${ours}..${theirs}`)
  const dir = yield* g.checkedOutIn(repo, local)
  const pulled = yield* Effect.result(
    dir !== null
      ? g.ok(dir, ["merge", "--ff-only", "--quiet", theirs])
      : g.ok(repo, ["update-ref", "-m", "huntaway: pull before worktree", local, theirs, ours]),
  )
  if (pulled._tag === "Success") {
    notes.push(["info", `Pulled ${base} from ${name} (${n} new commit${plural(n)})`, null])
    return start(theirs, base)
  }
  const e = pulled.failure
  notes.push(["info", `Branching from ${name}, ${n} commit${plural(n)} ahead of ${base}, which couldn't be fast-forwarded`, `${e.command} failed: ${e.reason}`])
  return start(theirs, name)
})
