import { Context, Effect, Layer, Schema } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"

// What the git area needs of GitHub (docs/plan/06-server.md, Git and GitHub), which sits below it in the dependency
// order: an HTTPS fetch authenticated as a task's GitHub account (huntaway's gh_mcp.authenticate_fetch), and a pull
// request read as that account (a task starting from a pull request). The interface is the git area's (plan task 4.1);
// the live layer is the github area's (`GitHubAccessLive`, github/Gh.ts, plan task 4.4), put in `Main.ts`'s github line.

/** gh couldn't be run, the account isn't signed in to it, or GitHub didn't answer: `reason` says which. */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable, { readonly brand: unique symbol }>()("GitHubUnavailable", {
  reason: Schema.String,
}) {}

/** A pull request as `gh pr view --json state,headRefName,baseRefName,headRefOid,isCrossRepository,url` gives it. */
export const PullRequestView = Schema.Struct({
  state: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  isCrossRepository: Schema.Boolean,
  url: Schema.String,
})
export type PullRequestView = typeof PullRequestView.Type

export interface GitHubAccessShape {
  /**
   * The environment for a fetch from `remoteUrl` (as git resolves the remote, `insteadOf` applied) in `cwd`,
   * authenticated as `account` over HTTPS on its host: `GIT_CONFIG_*` settings (git's `-c`, numbered from 0) that empty
   * the configured extra headers and put a credential helper of the account's in place of the host's others, and the
   * token it gives. `{}` with no account, and for SSH, local and other hosts' remotes (git's own authentication). A
   * missing login never falls back to another: the helpers are emptied and none given, so the fetch fails.
   */
  readonly fetchEnv: (cwd: string, account: string | null, remoteUrl: string) => Effect.Effect<Readonly<Record<string, string | undefined>>>
  /**
   * `gh pr view <ref> [--repo R] --json state,headRefName,baseRefName,headRefOid,isCrossRepository,url` in `cwd` as
   * `account` (gh's active account with none); null when there is no such pull request.
   */
  readonly pullRequest: (cwd: string, account: string | null, ref: string, repo: string | null) => Effect.Effect<PullRequestView | null, GitHubUnavailable>
  /**
   * 4.8 (`Restack`): linked stack level `task`'s level below was merged: wait for GitHub's own rebase of its branch (from
   * `pushed`, where the branch was on its remote, onto `base`), as `GhStacks.restacked`.
   */
  readonly restacked: (task: Task, dir: string, pushed: string, base: string) => Effect.Effect<GitHubRestack>
  /** 4.8: have `task`'s pull request (`url`) target `to`, unstacking it on GitHub first if it must (`GhStacks.retarget`). */
  readonly retarget: (task: Task, dir: string, url: string, to: string) => Effect.Effect<{ readonly moved: boolean } | { readonly error: string }>
  /** 4.8: link task `id`'s pull request into a stack on GitHub with the one below it, in the background (`GhStacks.link`). */
  readonly linkStacks: (id: TaskId) => Effect.Effect<void>
}

/** What GitHub did with a linked stack level once the one below was merged: only `rebased` means it restacked it. */
export type GitHubRestack = "rebased" | "conflict" | "unstacked" | "unknown"

/** No GitHub stacks: nothing is rebased by GitHub, no pull request retargeted, nothing linked (tests' fakes spread it). */
export const noGitHubStacks = (): Pick<GitHubAccessShape, "restacked" | "retarget" | "linkStacks"> => ({
  restacked: () => Effect.succeed("unknown"),
  retarget: () => Effect.succeed({ error: "GitHub isn't available on this server" }),
  linkStacks: () => Effect.void,
})

export class GitHubAccess extends Context.Service<GitHubAccess, GitHubAccessShape>()("huntaway-server/git/GitHubAccess") {
  /** No gh: fetches use git's own authentication, and no pull request can be read. */
  static readonly layerNone = Layer.succeed(
    GitHubAccess,
    GitHubAccess.of({
      fetchEnv: () => Effect.succeed({}),
      pullRequest: () => Effect.fail(new GitHubUnavailable({ reason: "GitHub isn't available on this server" })),
      ...noGitHubStacks(),
    }),
  )
}
