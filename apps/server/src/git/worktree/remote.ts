import { Effect } from "effect"
import type { GitShape } from "../Git.ts"
import { lines } from "../paths.ts"

// The GitHub repository a task's pull request goes to, from its repository's remotes (huntaway's git/worktree/remote.ts;
// inventory 04, section 2.11). Pure parsing, and reads of the repository's remotes through `Git`.

/** The GitHub repository a task's pull request goes to: the remote to push to, and the repository's `OWNER/REPO`. */
export interface Github {
  readonly remote: string
  readonly repo: string
}

/** Whether a remote's host is github.com's (its web, or SSH over HTTPS's port). */
export const isGithubCom = (host: string): boolean => ["github.com", "www.github.com", "ssh.github.com"].includes(host)

/**
 * The host (lowercase) and `OWNER/REPO` of a remote URL with a path of that shape, on any host: `git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@ssh.github.com:443/o/r.git` and the like.
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
  host = (at[at.length - 1] ?? "").split(":")[0]?.toLowerCase() ?? ""
  path = path.replace(/^\/+|\/+$/g, "")
  if (path.endsWith(".git")) path = path.slice(0, -4)
  const parts = path.split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts
  return owner !== undefined && owner !== "" && name !== undefined && name !== "" ? [host, `${owner}/${name}`] : null
}

/** Whether a remote URL is an SSH one whose host may be an alias in the SSH config (`git@github-work:o/r.git`). */
export const sshAlias = (url: string, host: string): boolean => {
  const ssh = !url.includes("://") || ["ssh://", "git+ssh://", "ssh+git://"].some((p) => url.startsWith(p))
  return ssh && !isGithubCom(host) && !host.startsWith("-") && /^[A-Za-z0-9\-_.]*$/.test(host)
}

/** The host an SSH alias stands for (`ssh -G`'s `hostname`), or the host as it is. */
export type SshHostname = (host: string) => Effect.Effect<string>

/** The remote `github` picks for a task branched from `base`, and its push URL. */
export const pushRemote = Effect.fnUntraced(function* (g: GitShape, repo: string, base: string | null) {
  const listed = yield* g.run(repo, ["remote"]).pipe(Effect.orElseSucceed(() => null))
  if (listed === null || !listed.ok) return null
  const remotes = lines(listed.stdout)
    .map((r) => r.trim())
    .filter((r) => r !== "")
  const upstream =
    base === null || base === ""
      ? null
      : yield* g.run(repo, ["config", `branch.${base}.remote`]).pipe(
          Effect.map((o) => o.stdout.trim()),
          Effect.orElseSucceed(() => null),
        )
  const remote =
    upstream !== null && remotes.includes(upstream) ? upstream : remotes.includes("origin") ? "origin" : remotes.length === 1 ? (remotes[0] ?? null) : null
  if (remote === null) return null
  const url = yield* g.ok(repo, ["remote", "get-url", "--push", remote]).pipe(Effect.orElseSucceed(() => null))
  return url === null ? null : ([remote, url.trim()] as const)
})

/** The host and `OWNER/REPO` that a task branched from `base` in `repo` pushes to, as `github` picks the remote, on any host. */
export const pushRepo = Effect.fnUntraced(function* (g: GitShape, ssh: SshHostname, repo: string, base: string | null) {
  const pushed = yield* pushRemote(g, repo, base)
  if (pushed === null) return null
  const r = remoteRepo(pushed[1])
  if (r === null) return null
  const host = sshAlias(pushed[1], r[0]) ? yield* ssh(r[0]) : r[0]
  return [host, r[1]] as const
})

/**
 * Where a task branched from `base` in `repo` opens its pull request, if that's on GitHub: `base`'s upstream remote, or
 * else `origin` (or the only remote), going by where it pushes to.
 */
export const github = Effect.fnUntraced(function* (g: GitShape, ssh: SshHostname, repo: string, base: string | null) {
  const pushed = yield* pushRemote(g, repo, base)
  if (pushed === null) return null
  const r = remoteRepo(pushed[1])
  if (r === null) return null
  const host = sshAlias(pushed[1], r[0]) ? yield* ssh(r[0]) : r[0]
  const found: Github = { repo: r[1], remote: pushed[0] }
  return isGithubCom(host) ? found : null
})
