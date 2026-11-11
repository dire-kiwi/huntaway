import { Effect, Layer, Option, Schema } from "effect"
import { GitHubAccess, GitHubUnavailable, PullRequestView } from "../git/GitHubAccess.ts"
import { Gh } from "./Gh.ts"

// What the git area needs of GitHub (`GitHubAccess`, git/GitHubAccess.ts), as `Gh` runs it: an HTTPS fetch as a task's
// account, and a pull request read as it (huntaway's gh_mcp.authenticate_fetch, and git/worktree/start.ts's `gh pr
// view` of a task that starts from a pull request).

const FIELDS = "state,headRefName,baseRefName,headRefOid,isCrossRepository,url"

/** What gh says when there's no such pull request (rather than that it couldn't ask). */
const NONE = /no pull requests? found|could not resolve to a pullrequest/i

const decodeView = Schema.decodeOption(Schema.fromJsonString(PullRequestView))

export const GitHubAccessLive = Layer.effect(
  GitHubAccess,
  Effect.gen(function* () {
    const gh = yield* Gh
    return GitHubAccess.of({
      fetchEnv: gh.fetchEnv,
      pullRequest: Effect.fn("GitHubAccess.pullRequest")(function* (cwd: string, account: string | null, ref: string, repo: string | null) {
        const args = ["pr", "view", ref, ...(repo === null ? [] : ["--repo", repo]), "--json", FIELDS]
        const out = yield* gh.gh(args, { cwd, account, timeout: "30 seconds" }).pipe(Effect.mapError((e) => new GitHubUnavailable({ reason: e.message })))
        if (out.code === 0) {
          const view = decodeView(out.stdout)
          if (Option.isNone(view)) return yield* new GitHubUnavailable({ reason: `unexpected answer from gh: ${out.stdout.trim().slice(0, 200)}` })
          return view.value
        }
        if (NONE.test(out.stderr)) return null
        return yield* new GitHubUnavailable({ reason: out.stderr.trim() === "" ? `gh pr view exited with ${String(out.code)}` : out.stderr.trim() })
      }),
    })
  }),
)
