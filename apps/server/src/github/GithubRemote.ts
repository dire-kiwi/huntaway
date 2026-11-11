import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Git } from "../git/Git.ts"
import { lines } from "../git/paths.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"

// The GitHub repository a task's pull request goes to (inventory 04, section 2.11 `github(repo, base)`; huntaway's
// git/worktree/remote.ts): the remote a branch from `base` is pushed to, its push URL read as a host and `OWNER/REPO`,
// an SSH host alias resolved to the host it stands for (`ssh -G`, 5 seconds), and only github.com's hosts counted.

/** Where a task's pull request goes: the remote to push to, and the repository's `OWNER/REPO`. */
export interface Github {
  readonly remote: string
  readonly repo: string
}

/**
 * The host (lowercase) and `OWNER/REPO` of a remote URL with a path of that shape, on any host:
 * `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@ssh.github.com:443/o/r.git` and the like.
 */
export const remoteRepo = (url: string): readonly [string, string] | null => {
  let host: string
  let path: string
  const scheme = url.indexOf("://")
  if (scheme >= 0) {
    const rest = url.slice(scheme + 3)
    const slash = rest.indexOf("/")
    if (slash < 0) return null
    host = rest.slice(0, slash)
    path = rest.slice(slash + 1)
  } else {
    // scp-like `[user@]host:path`; a local path has a slash before any colon.
    const colon = url.indexOf(":")
    if (colon < 0) return null
    host = url.slice(0, colon)
    path = url.slice(colon + 1)
    if (host.includes("/")) return null
  }
  const at = host.split("@")
  host = ((at[at.length - 1] ?? "").split(":")[0] ?? "").toLowerCase()
  path = path.replace(/^\/+|\/+$/g, "")
  if (path.endsWith(".git")) path = path.slice(0, -4)
  const parts = path.split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts
  return owner !== undefined && owner !== "" && name !== undefined && name !== "" ? [host, `${owner}/${name}`] : null
}

/** Whether a remote's host is github.com's (its web, or SSH over HTTPS's port). */
export const isGithubCom = (host: string): boolean => ["github.com", "www.github.com", "ssh.github.com"].includes(host)

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
       * The host an SSH remote's `host` stands for: an alias's `HostName` in the SSH config, as `ssh -G` has it. Several
       * GitHub accounts are often set up with an alias for each one's key (`git@github-work:o/r.git`). Other remotes'
       * hosts, and those ssh can't look up, are as they are.
       */
      const sshHostname = Effect.fnUntraced(function* (url: string, host: string) {
        const ssh = !url.includes("://") || ["ssh://", "git+ssh://", "ssh+git://"].some((p) => url.startsWith(p))
        const alias = !isGithubCom(host) && !host.startsWith("-") && /^[A-Za-z0-9\-_.]*$/.test(host)
        if (!ssh || !alias) return host
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

      const pushRemote = Effect.fn("GithubRemote.pushRemote")(function* (repo: string, base: string | null) {
        const listed = yield* git.run(repo, ["remote"]).pipe(Effect.orElseSucceed(() => null))
        if (listed === null || !listed.ok) return null
        const remotes = lines(listed.stdout)
          .map((r) => r.trim())
          .filter((r) => r !== "")
        const upstream =
          base === null || base === ""
            ? null
            : yield* git.run(repo, ["config", `branch.${base}.remote`]).pipe(
                Effect.map((o) => o.stdout.trim()),
                Effect.orElseSucceed(() => null),
              )
        const remote =
          upstream !== null && remotes.includes(upstream)
            ? upstream
            : remotes.includes("origin")
              ? "origin"
              : remotes.length === 1
                ? (remotes[0] ?? null)
                : null
        if (remote === null) return null
        const url = yield* git.ok(repo, ["remote", "get-url", "--push", remote]).pipe(Effect.orElseSucceed(() => null))
        return url === null ? null : ([remote, url] as const)
      })

      const pushRepo = Effect.fn("GithubRemote.pushRepo")(function* (repo: string, base: string | null) {
        const pushed = yield* pushRemote(repo, base)
        if (pushed === null) return null
        const url = pushed[1].trim()
        const r = remoteRepo(url)
        if (r === null) return null
        return [yield* sshHostname(url, r[0]), r[1]] as const
      })

      const github = Effect.fn("GithubRemote.github")(function* (repo: string, base: string | null) {
        const pushed = yield* pushRemote(repo, base)
        if (pushed === null) return null
        const [remote, raw] = pushed
        const url = raw.trim()
        const r = remoteRepo(url)
        if (r === null) return null
        const found: Github = { remote, repo: r[1] }
        return isGithubCom(yield* sshHostname(url, r[0])) ? found : null
      })

      return GithubRemote.of({ github, pushRepo, pushRemote })
    }),
  )
}
