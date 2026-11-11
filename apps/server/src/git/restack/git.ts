import type { FileSystem } from "effect"
import { Effect } from "effect"
import type { GitShape } from "../Git.ts"
import type { GitHubAccessShape } from "../GitHubAccess.ts"

// The git a restack runs (huntaway's git/worktree/restack.ts `rebase`, `move_branch`, `push`, `merge_base`): a rebase of
// a level's own commits in a throwaway worktree of its own, with the repository's hooks off; its branch moved with an
// old-value check; and a push with a lease on the remote head the restack read.

/** Git without the repository's hooks, which are the agent's checks of its own work, not the board's to run. */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const

/** How long a rebase may take. */
const REBASE_LIMIT = "5 minutes"
/** How long a push may take. */
const PUSH_LIMIT = "120 seconds"

/** Why a restack can't be done by the board: its agent is asked to (or the user, after it). */
export interface Conflicted {
  readonly conflict: string
  readonly detail?: string | undefined
}

/** The output of `git merge-base a b` in `repo`, if it has one. */
export const mergeBase = (g: GitShape, repo: string, a: string, b: string) =>
  g.run(repo, ["merge-base", a, b]).pipe(
    Effect.map((o) => (o.ok ? o.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  )

/**
 * Rebase the commits `start..head` of `repo` onto `tip` in a detached worktree of its own under a temp folder
 * (`huntaway-restack-`), which goes again after: the new head, or why it couldn't. The task's own worktree isn't touched.
 */
export const rebase = (
  g: GitShape,
  fs: FileSystem.FileSystem,
  repo: string,
  start: string,
  head: string,
  tip: string,
): Effect.Effect<{ readonly head: string } | Conflicted> =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-restack-" }).pipe(Effect.orDie)
      const wt = `${dir}/wt`
      yield* Effect.addFinalizer(() =>
        Effect.andThen(g.run(repo, ["worktree", "remove", "--force", wt]).pipe(Effect.ignore), g.run(repo, ["worktree", "prune"]).pipe(Effect.ignore)),
      )
      const added = yield* g.run(repo, [...NO_HOOKS, "worktree", "add", "--detach", "--quiet", wt, head])
      if (!added.ok) return { conflict: "its commits couldn't be checked out to rebase them", detail: added.stderr.trim() } satisfies Conflicted
      // Commits are made as the repository's user, or else as their author.
      const env: Record<string, string> = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }
      if (!(yield* g.run(repo, ["var", "GIT_COMMITTER_IDENT"])).ok) {
        const [name, email] = (yield* g.run(repo, ["log", "-1", "--format=%an%n%ae", head])).stdout.split("\n")
        env["GIT_COMMITTER_NAME"] = name !== undefined && name !== "" ? name : "Huntaway"
        env["GIT_COMMITTER_EMAIL"] = email !== undefined && email !== "" ? email : "huntaway@localhost"
      }
      const out = yield* g.run(wt, [...NO_HOOKS, "rebase", "--no-autosquash", "--no-update-refs", "--quiet", "--onto", tip, start], {
        env,
        timeout: REBASE_LIMIT,
      })
      if (!out.ok) {
        yield* g.run(wt, ["rebase", "--abort"]).pipe(Effect.ignore)
        const detail = `${out.stdout}${out.stderr}`.trim()
        return { conflict: /conflict/i.test(detail) ? "its commits conflict with it" : "git rebase failed", detail } satisfies Conflicted
      }
      return { head: (yield* g.ok(wt, ["rev-parse", "HEAD"])).trim() }
    }),
  ).pipe(Effect.catchTag("GitFailed", (e) => Effect.succeed({ conflict: "git rebase failed", detail: e.reason } satisfies Conflicted)))

/**
 * Move branch `local` (`refs/heads/…`) from `from` to `to`: in the worktree it's checked out in, if any (`wt`), keeping
 * what's there (`reset --keep`), else only if it's still at `from`. Why not, if it couldn't.
 */
export const moveBranch = (g: GitShape, repo: string, wt: string | null, local: string, to: string, from: string) =>
  Effect.gen(function* () {
    if (wt !== null) {
      if ((yield* g.commit(wt, "HEAD")) !== from) return `${wt} isn't at ${from}`
      const out = yield* g.run(wt, [...NO_HOOKS, "reset", "--keep", "--quiet", to])
      return out.ok ? null : out.stderr.trim()
    }
    const out = yield* g.run(repo, ["update-ref", "-m", "huntaway: restack", local, to, from])
    return out.ok ? null : out.stderr.trim()
  }).pipe(Effect.catchTag("GitFailed", (e) => Effect.succeed(e.reason)))

/**
 * Push `head` to `merge` (`refs/heads/…`) on `remote`, with a lease on `expected` (what it was when read), hooks off,
 * authenticated as `account` as fetches are: null if it went, else why not.
 */
export const push = (g: GitShape, gh: GitHubAccessShape, repo: string, remote: string, merge: string, head: string, expected: string, account: string | null) =>
  Effect.gen(function* () {
    const url = yield* g.run(repo, ["remote", "get-url", remote]).pipe(
      Effect.map((o) => (o.ok ? o.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    )
    const env = url === "" ? {} : yield* gh.fetchEnv(repo, account, url)
    const out = yield* g.run(repo, ["push", "--quiet", "--no-verify", `--force-with-lease=${merge}:${expected}`, remote, `${head}:${merge}`], {
      env,
      timeout: PUSH_LIMIT,
    })
    return out.ok ? null : out.stderr.trim() || "git push failed"
  }).pipe(Effect.catchTag("GitFailed", (e) => Effect.succeed(e.code === null && e.reason.startsWith("timed out") ? "git push timed out" : e.reason)))
