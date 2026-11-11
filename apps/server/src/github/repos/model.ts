import { Option, Predicate, Schema } from "effect"
import type { GithubAccount, GithubRepo } from "@huntaway/contracts"
import { accountName, parseAccount } from "@huntaway/shared"

// 6.11: the pure part of adding a project from GitHub (the old `integrations/github.ts`): what a search asks, what is
// shown of a repository, which names are a repository's, and what gh said when it failed.

/**
 * How many pages of 100 of the repositories the account owns or collaborates on are listed, most recently pushed
 * first. Its organizations' are searched rather than listed (one can have tens of thousands).
 */
export const PAGES = 3

/** How many repositories a search finds at most. */
export const SEARCH_RESULTS = 50

/**
 * The GraphQL query for the repositories the account has contributed to lately (commits, pull requests and their
 * reviews, issues), others' (organizations') only.
 */
export const CONTRIBUTED =
  "query=query { viewer { repositoriesContributedTo(first: 100, includeUserRepositories: false, " +
  "contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, ISSUE, REPOSITORY]) { nodes { nameWithOwner name description isPrivate " +
  "isFork isArchived pushedAt url } } } }"

/** The REST API's page `n` of the repositories the account owns or collaborates on, newest push first. */
export const userReposPage = (n: number) => `user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=${n}`

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : false)
const field = (v: unknown, k: string): unknown => (Predicate.hasProperty(v, k) ? v[k] : undefined)

/** What the dialog shows of a repository from GitHub's REST API, or null for one without a `full_name`. */
export const restRepo = (r: unknown): GithubRepo | null => {
  const fullName = str(field(r, "full_name"))
  if (fullName === null) return null
  return {
    full_name: fullName,
    name: str(field(r, "name")) ?? fullName.split("/").pop() ?? fullName,
    description: str(field(r, "description")),
    private: bool(field(r, "private")),
    fork: bool(field(r, "fork")),
    archived: bool(field(r, "archived")),
    pushed_at: str(field(r, "pushed_at")),
    url: str(field(r, "html_url")),
  }
}

/** `restRepo` for a repository from the GraphQL API. */
export const graphqlRepo = (r: unknown): GithubRepo | null =>
  restRepo({
    full_name: field(r, "nameWithOwner"),
    name: field(r, "name"),
    description: field(r, "description"),
    private: field(r, "isPrivate"),
    fork: field(r, "isFork"),
    archived: field(r, "isArchived"),
    pushed_at: field(r, "pushedAt"),
    html_url: field(r, "url"),
  })

/** The repositories of an answer that is a list of them (or has them in `items`), as shown. */
export const reposOf = (v: unknown, of: (r: unknown) => GithubRepo | null = restRepo): ReadonlyArray<GithubRepo> =>
  (Array.isArray(v) ? v : []).map(of).filter((r): r is GithubRepo => r !== null)

/** The repositories the GraphQL query found the account contributed to. */
export const contributedOf = (v: unknown): ReadonlyArray<GithubRepo> =>
  reposOf(field(field(field(field(v, "data"), "viewer"), "repositoriesContributedTo"), "nodes"), graphqlRepo)

/** The `login` of `gh api user`'s answer. */
export const loginOf = (v: unknown): string | null => str(field(v, "login"))

/** The logins of `gh api user/orgs`'s answer. */
export const orgsOf = (v: unknown): ReadonlyArray<string> =>
  (Array.isArray(v) ? v : []).map((o) => str(field(o, "login"))).filter((l): l is string => l !== null)

/** `repos` without repeats (by name, in any case), most recently pushed first; those never pushed to go last. */
export const latestFirst = (repos: ReadonlyArray<GithubRepo>): ReadonlyArray<GithubRepo> => {
  const seen = new Set<string>()
  const out = repos.filter((r) => {
    const k = r.full_name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  // ISO times, which sort as text.
  return out.toSorted((a, b) => {
    const [x, y] = [a.pushed_at, b.pushed_at]
    if (x === y) return 0
    if (x === null) return 1
    if (y === null) return -1
    return x < y ? 1 : -1
  })
}

/** What logins and repository names are made of in `s`, as words. */
const words = (s: string) => s.split(/[^A-Za-z0-9\-_.]/).filter((w) => w !== "")

/**
 * The search API's query for repositories whose names are like `text`, among `owners`', or OWNER's for `OWNER/NAME`
 * (all of them for `OWNER/`). None when there's nothing to search for. Only what logins and repository names are made
 * of is kept, so what's typed adds no qualifiers.
 */
export const searchQuery = (text: string, owners: ReadonlyArray<string>): string | null => {
  let os: ReadonlyArray<string>
  let name: ReadonlyArray<string>
  const slash = text.indexOf("/")
  if (slash >= 0) {
    const owner = words(text.slice(0, slash))
    os = owner.length > 0 ? owner : owners
    name = words(text.slice(slash + 1))
  } else [os, name] = [owners, words(text)]
  if (os.length === 0 || (name.length === 0 && !text.includes("/"))) return null
  return `${name.join(" ")} in:name fork:true ${os.map((o) => `user:${o}`).join(" ")}`.trim()
}

const nameChars = (p: string) => p.length > 0 && p.length <= 100 && /^[A-Za-z0-9\-_.]+$/.test(p)

/**
 * `OWNER/REPO` (a trailing `.git` dropped), if `s` is one: logins and repository names are letters, digits, `-`, `_` and
 * `.`, and a login doesn't start with the last three, so it's no option to gh.
 */
export const checkRepo = (given: string): string | null => {
  const s = given.trim()
  const base = s.endsWith(".git") ? s.slice(0, -4) : s
  const i = base.indexOf("/")
  if (i < 0) return null
  const [owner, name] = [base.slice(0, i), base.slice(i + 1)]
  const good = nameChars(owner) && !/^[-_.]/.test(owner) && nameChars(name) && name !== "." && name !== ".."
  return good ? `${owner}/${name}` : null
}

/** A repository name on GitHub: letters, digits, `-`, `_` and `.`, up to 100 of them. */
export const checkName = (given: string): string | null => {
  const s = given.trim()
  return nameChars(s) && s !== "." && s !== ".." ? s : null
}

/** What gh said when it failed: its last few lines, less git's "Cloning into …". */
export const ghError = (stderr: string): string => {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("Cloning into"))
  return lines.length > 0 ? lines.slice(Math.max(0, lines.length - 6)).join(" ") : "gh failed"
}

const AuthStatus = Schema.Struct({
  hosts: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ login: Schema.optional(Schema.Unknown), active: Schema.optional(Schema.Unknown), state: Schema.optional(Schema.Unknown) })),
  ),
})

/** The accounts of `gh auth status --json=hosts`'s answer, by host (sorted), each as a profile would name it. */
export const accountsFromStatus = (v: unknown): ReadonlyArray<GithubAccount> =>
  Option.match(Schema.decodeUnknownOption(AuthStatus)(v), {
    onNone: () => [],
    onSome: ({ hosts }) =>
      Object.keys(hosts)
        .toSorted()
        .flatMap((host) =>
          (hosts[host] ?? []).flatMap((a) => {
            const account = typeof a.login === "string" ? parseAccount(`${host}/${a.login}`) : null
            return account === null
              ? []
              : [{ account: accountName(account), host: account.host, login: account.login, active: a.active === true, ok: a.state === "success" }]
          }),
        ),
  })

/** The folder name a clone of `OWNER/REPO` goes in. */
export const repoFolder = (repo: string): string => repo.slice(repo.indexOf("/") + 1)
