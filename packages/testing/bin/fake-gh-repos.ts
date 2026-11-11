// 6.11: the fake GitHub's repositories as an account sees them, for adding a project from GitHub (fake-gh.ts says what
// else it answers): `api user/repos`, `api user/orgs`, `api search/repositories`, the GraphQL query for the repositories
// an account contributed to, `repo clone` (from a repository's `source`, a folder on this machine), `repo create` and
// `config get git_protocol`. Plain Node, as fake-gh.ts; its helpers are given (fake-gh.ts runs as it's loaded).
//
// A repository's `owner` is the first part of its key; `collaborators` and `contributors` list other logins that see it
// (`user/repos`) or contributed to it (the GraphQL query); `cloneFails` fails a clone before it starts, and `cloneBreaks`
// after it: its checkout (`checkout`, which git keeps), or gh once it's whole (`after`, a fork's parent it can't add). `orgs` (by login) are an account's organizations. A clone runs
// `git clone <source>` and points `origin` at the repository on GitHub; a repository made with `repo create` is added to
// `repos` (`created: true`, `private`, and `pushed` when it was pushed), unless `createFails` says why it can't be, and its
// push fails when `pushFails` says why (the repository and remote stay, as with gh).
import { execFileSync } from "node:child_process"

import type { Account, Json, Repo, State } from "./fake-gh-state.ts"

export interface Helpers {
  readonly fail: (message: string, code?: number) => never
  readonly repoKey: (given: string) => string | null
}

const ownerOf = (key: string) => key.split("/").at(-2) ?? ""
const nameOf = (key: string) => key.split("/").at(-1) ?? ""
const hostOf = (key: string) => (key.split("/").length === 3 ? (key.split("/")[0] ?? "github.com") : "github.com")

/** The REST API's view of a repository. */
const rest = (key: string, r: Repo) => ({
  full_name: `${ownerOf(key)}/${nameOf(key)}`,
  name: nameOf(key),
  description: r.description ?? null,
  private: r.private ?? false,
  fork: r.fork ?? false,
  archived: r.archived ?? false,
  pushed_at: r.pushed_at ?? null,
  html_url: `https://${hostOf(key)}/${ownerOf(key)}/${nameOf(key)}`,
})

/** git with the board's `GIT_CONFIG_*` settings left out, so a clone from a folder on this machine is allowed. */
const gitPlain = (args: Array<string>, cwd?: string) => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith("GIT_CONFIG_")) delete env[k]
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
}

/** `gh api <endpoint>` for what this file answers, or undefined for the rest. */
export const reposApi = (state: State, as: Account | null, endpoint: string, fields: Json): unknown => {
  const login = as?.login ?? ""
  const all = Object.entries(state.repos ?? {})
  if (endpoint.startsWith("user/repos")) {
    const page = Number(new URLSearchParams(endpoint.slice(endpoint.indexOf("?") + 1)).get("page") ?? "1")
    const mine = all.filter(([k, r]) => ownerOf(k) === login || (r.collaborators ?? []).includes(login))
    return mine
      .map(([k, r]) => rest(k, r))
      .toSorted((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""))
      .slice((page - 1) * 100, page * 100)
  }
  if (endpoint.startsWith("user/orgs")) return (state.orgs?.[login] ?? []).map((o) => ({ login: o }))
  if (endpoint.startsWith("search/repositories")) {
    const q = typeof fields["q"] === "string" ? fields["q"] : ""
    const words = q.split(/\s+/).filter((w) => w !== "" && !w.includes(":"))
    const users = new Set(
      q
        .split(/\s+/)
        .filter((w) => w.startsWith("user:"))
        .map((w) => w.slice(5).toLowerCase()),
    )
    const items = all
      .filter(([k]) => users.has(ownerOf(k).toLowerCase()) && words.every((w) => nameOf(k).toLowerCase().includes(w.toLowerCase())))
      .map(([k, r]) => rest(k, r))
    return { total_count: items.length, items }
  }
  return undefined
}

/** The GraphQL query for the repositories `as` contributed to (others'), or undefined for another query. */
export const contributedQuery = (state: State, as: Account | null, query: string): unknown => {
  if (!query.includes("repositoriesContributedTo")) return undefined
  const login = as?.login ?? ""
  const nodes = Object.entries(state.repos ?? {})
    .filter(([k, r]) => ownerOf(k) !== login && (r.contributors ?? []).includes(login))
    .map(([k, r]) => {
      const x = rest(k, r)
      return {
        nameWithOwner: x.full_name,
        name: x.name,
        description: x.description,
        isPrivate: x.private,
        isFork: x.fork,
        isArchived: x.archived,
        pushedAt: x.pushed_at,
        url: x.html_url,
      }
    })
  return { data: { viewer: { repositoriesContributedTo: { nodes } } } }
}

/** `gh repo clone <repo> <dest>`: a clone of the repository's `source` folder, its `origin` the repository on GitHub. */
export const repoClone = (state: State, h: Helpers, positional: Array<string>): string => {
  const given = positional[2] ?? h.fail("repo clone: a repository is required")
  const dest = positional[3] ?? nameOf(given)
  const key = h.repoKey(given) ?? h.fail(`expected the "[HOST/]OWNER/REPO" format, got "${given}"`)
  const repo = state.repos?.[key] ?? h.fail(`GraphQL: Could not resolve to a Repository with the name '${ownerOf(key)}/${nameOf(key)}'. (repository)`)
  if (repo.cloneFails !== undefined) h.fail(repo.cloneFails)
  const source = repo.source ?? h.fail(`fake gh: ${key} has no source folder to clone`)
  try {
    gitPlain(["clone", "-q", ...(repo.cloneBreaks === "checkout" ? ["--no-checkout"] : []), source, dest])
  } catch (e) {
    h.fail(`git clone failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const url = given.includes("@") ? given : `https://${hostOf(key)}/${ownerOf(key)}/${nameOf(key)}.git`
  gitPlain(["-C", dest, "remote", "set-url", "origin", url])
  // Git keeps a clone whose checkout failed; gh fails after a whole clone when it can't add a fork's parent.
  if (repo.cloneBreaks === "checkout")
    h.fail("error: external filter 'false' failed\nfatal: README: smudge filter broken failed\nwarning: Clone succeeded, but checkout failed.")
  if (repo.cloneBreaks === "after") h.fail("failed to run git: couldn't fetch upstream")
  return ""
}

/** `gh repo create [HOST/][OWNER/]NAME --private|--public --source DIR --remote origin [--push]`. */
export const repoCreate = (state: State, h: Helpers, as: Account | null, positional: Array<string>, flags: Map<string, Array<string>>): string => {
  const given = positional[2] ?? h.fail("repo create: a name is required")
  const parts = given.split("/")
  const host = parts.length === 3 ? (parts[0] ?? "github.com") : "github.com"
  const owner = parts.length >= 2 ? (parts.at(-2) ?? "") : (as?.login ?? h.fail("fake gh: no account to own the repository"))
  const name = parts.at(-1) ?? ""
  const key = host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`
  if (state.createFails !== undefined) h.fail(state.createFails)
  if (state.repos?.[key] !== undefined) h.fail("GraphQL: Name already exists on this account (createRepository)")
  const source = flags.get("source")?.[0] ?? h.fail("fake gh: --source is required")
  const repo: Repo = { private: flags.has("private"), created: true, pushed: false, pushed_at: null }
  ;(state.repos ??= {})[key] = repo
  const url = `https://${host}/${owner}/${name}.git`
  gitPlain(["-C", source, "remote", "add", flags.get("remote")?.[0] ?? "origin", url])
  if (flags.has("push")) {
    if (state.pushFails !== undefined) h.fail(state.pushFails)
    repo.pushed = true
  }
  return `https://${host}/${owner}/${name}\n`
}

/** `gh config get git_protocol --host H`: the state's, else gh's default. */
export const gitProtocol = (state: State, host: string | null): string => `${state.gitProtocol?.[host ?? "github.com"] ?? "https"}\n`
