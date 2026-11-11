import { Context, Effect, Layer, Schema } from "effect"

// What the git area needs of GitHub (docs/plan/06-server.md, Git; HE-5's seams). GitHub sits below git in the dependency
// order, so git declares what it needs here and `github/` provides it (4.4, `GitHubAccessLive`); `layerNone` is a board
// without gh: fetches go unauthenticated and pull requests can't be read.

/** gh can't be asked: none on the machine, not logged in as the account, or it failed. `reason` is short and has no token. */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable, { readonly brand: unique symbol }>()("GitHubUnavailable", {
  reason: Schema.String,
}) {}

/** A pull request as `gh pr view <ref> --json state,headRefName,baseRefName,headRefOid,isCrossRepository,url` reads it. */
export const PullRequestView = Schema.Struct({
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  isCrossRepository: Schema.Boolean,
  url: Schema.String,
})
export type PullRequestView = typeof PullRequestView.Type

export interface GitHubAccessShape {
  /**
   * The environment for a `git fetch` in `cwd` from `remoteUrl` authenticated as `account` (the old
   * `gh_mcp.authenticate_fetch`): a credential helper for an HTTPS GitHub remote, `{}` for anything else, for no
   * account, or when gh can't give one (the fetch then goes as git would on its own).
   */
  readonly fetchEnv: (cwd: string, account: string | null, remoteUrl: string) => Effect.Effect<Readonly<Record<string, string | undefined>>>
  /**
   * `gh pr view <ref> [--repo R]` in `cwd` as `account` (none: gh's default login): the pull request `ref` (a number, a
   * URL or a branch) names, or null when there is none.
   */
  readonly pullRequest: (cwd: string, account: string | null, ref: string, repo: string | null) => Effect.Effect<PullRequestView | null, GitHubUnavailable>
}

export class GitHubAccess extends Context.Service<GitHubAccess, GitHubAccessShape>()("huntaway-server/git/GitHubAccess") {
  /** No gh: fetches unauthenticated, no pull request can be read. */
  static readonly layerNone = Layer.succeed(
    GitHubAccess,
    GitHubAccess.of({
      fetchEnv: () => Effect.succeed({}),
      pullRequest: () => Effect.fail(new GitHubUnavailable({ reason: "gh isn't available on this server yet" })),
    }),
  )
}
