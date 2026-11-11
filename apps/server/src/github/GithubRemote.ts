import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Git } from "../git/Git.ts"
import { lines } from "../git/paths.ts"
import * as remote from "../git/worktree/remote.ts"
import type { Github } from "../git/worktree/remote.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"

// The GitHub repository a task's pull request goes to (inventory 04, section 2.11 `github(repo, base)`; huntaway's
// git/worktree/remote.ts): the remote a branch from `base` is pushed to, its push URL read as a host and `OWNER/REPO`,
// an SSH host alias resolved to the host it stands for (`ssh -G`, 5 seconds), and only github.com's hosts counted.

export type { Github } from "../git/worktree/remote.ts"
export { isGithubCom, remoteRepo } from "../git/worktree/remote.ts"

export interface GithubRemoteShape {
  /**
   * Where a task branched from `base` in `repo` opens its pull request, if that's on GitHub: `base`'s upstream remote,
   * or else `origin` (or the only remote), going by where it pushes to.
   */
  readonly github: (repo: string, base: string | null) => Effect.Effect<Github | null>
  /** The host and `OWNER/REPO` that a branch from `base` in `repo` is pushed to, as `github` picks the remote, on any host. */
  readonly pushRepo: (repo: string, base: string | null) => Effect.Effect<readonly [string, string] | null>
  /** The remote `github` picks, and its push URL. */
  readonly pushRemote: (repo: string, base: string | null) => Effect.Effect<readonly [string, string] | null>
}

export class GithubRemote extends Context.Service<GithubRemote, GithubRemoteShape>()("huntaway-server/github/GithubRemote") {
  static readonly layer = Layer.effect(
    GithubRemote,
    Effect.gen(function* () {
      const git = yield* Git
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const config = yield* ServerConfig

      /**
       * The host an SSH alias stands for: its `HostName` in the SSH config, as `ssh -G` has it. Several GitHub accounts
       * are often set up with an alias for each one's key (`git@github-work:o/r.git`). Hosts ssh can't look up are as
       * they are.
       */
      const ssh = Effect.fnUntraced(function* (host: string) {
        const args = [...(config.sshConfig === null ? [] : ["-F", config.sshConfig]), "-G", "--", host]
        const out = yield* spawner.string(ChildProcess.make("ssh", args, { env: config.agentEnv, extendEnv: true, stdin: "ignore", stderr: "ignore" })).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(null) }),
          Effect.orElseSucceed(() => null),
        )
        if (out === null) return host
        const line = lines(out).find((l) => l.startsWith("hostname "))
        const name = line?.slice("hostname ".length).trim().toLowerCase()
        return name === undefined || name === "" ? host : name
      })
      // The rules are the git area's (`git/worktree/remote.ts`, which `TaskBase` uses too).
      const github = (repo: string, base: string | null) => remote.github(git, ssh, repo, base)
      const pushRepo = (repo: string, base: string | null) => remote.pushRepo(git, ssh, repo, base)
      const pushRemote = (repo: string, base: string | null) => remote.pushRemote(git, repo, base)

      return GithubRemote.of({ github, pushRepo, pushRemote })
    }),
  )
}
