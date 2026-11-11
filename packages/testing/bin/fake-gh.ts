// A stand-in `gh` over a fake GitHub (docs/plan/10-testing.md, packages/testing): what the board and its agents run
// of the GitHub CLI, answered from a JSON file instead of GitHub, so that the gh tools, `gh-run`, pull requests' reads,
// merges and stacks are tested without the network or a real repository on GitHub. Plain Node: it stands in for an
// outside program. Tests make its state and read it back with `fakeGitHub` (src/fakeGitHub.ts), which also writes the
// `gh` script to give the server (`ghBin`); test servers take it with `scripts/test-server.sh --fake-gh`.
//
// The state is the JSON file named by $HUNTAWAY_FAKE_GH_STATE (`FakeGitHubState` in src/fakeGitHub.ts has its types):
//
//   accounts     the logins gh has: { host, login, token, active? }. `auth token --hostname=H --user=U` prints U's
//                token; a call made with a GH_CONFIG_DIR (the board's private config, its hosts.yml) acts as the
//                account whose token is in it, and is refused (HTTP 401) for a token no account has; one without
//                acts as the host's active account.
//   repos        by `OWNER/REPO` (github.com) or `HOST/OWNER/REPO`: its default branch, pull requests (`pulls`: number,
//                title, body, state OPEN|CLOSED|MERGED, head, base, headOid, mergeable, checks, reviews, comments,
//                stack, mergeAsync…), issues, workflow runs and GitHub stacks (`stacks`: number → its pull requests,
//                bottom first). A test sets any of it; a merge, a comment or a new pull request changes it.
//   defaultRepo  the repository a call goes to when neither `--repo`, GH_REPO nor the working directory's `origin`
//                remote names one.
//   help         `gh <command> [sub] --help` texts by "command sub" (none: gh has no help, exit 1).
//   routes       answers by the call's exact arguments joined with spaces ({ stdout, stderr, code } or { json }),
//                taken before anything else: what a test needs that the rest doesn't do.
//   calls        every call, appended: its arguments, working directory, the account it acted as (`as`), GH_HOST
//                and GH_REPO, whether it had a token in its environment (`envToken`), its GH_CONFIG_DIR and the
//                modes of that folder and its hosts.yml (`configModes`, octal), and the keyring's bus (`dbus`).
//
// What it answers: `--version`; `auth token|status`; `pr create|view|list|checks|diff|comment|edit|merge|close`;
// `issue view|list|create|comment`; `run list|view`; `repo view`; `api` for `user`, `repos/O/R`, `repos/O/R/pulls/N`
// (GET, PATCH), `.../pulls/N/merge` (PUT), `.../pulls/N/merge-async` (PUT, then GET of its id), `repos/O/R/stacks/N`,
// and `graphql` for a pull request (state, checks, comments, reviews and review threads, paged, as PrWatch reads it)
// and for many pull requests' states at once (the merged watcher's); `run view --job N --log-failed` from the repository's
// `jobs`. `--json` picks fields, and `--jq` takes a path (`.url`, `.a.b`). Anything else fails as gh does
// for a command it doesn't have. Calls change the file under a lock (a folder beside it), so concurrent ones don't
// lose each other's changes.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs"

type Json = Record<string, unknown>

interface Account {
  host: string
  login: string
  token: string
  active?: boolean
}
interface Check {
  name: string
  state: string
  bucket: string
  workflow?: string
  link?: string
  startedAt?: string
  completedAt?: string
  id?: number
  conclusion?: string
  required?: boolean
  kind?: string
  suite?: { id: number; status: string }
}
interface Comment {
  author: string
  body: string
  createdAt?: string
  authorAssociation?: string
  id?: string
  bot?: boolean
  url?: string
}
interface Review {
  author: string
  state: string
  body?: string
  submittedAt?: string
  authorAssociation?: string
  id?: string
  bot?: boolean
  url?: string
}
interface ThreadComment {
  author: string
  body: string
  id?: string
  createdAt?: string
  authorAssociation?: string
  bot?: boolean
  url?: string
  line?: number | null
}
interface Thread {
  path: string
  comments: Array<ThreadComment>
}
interface Pull {
  number: number
  title: string
  body: string
  state: string
  isDraft?: boolean
  head: string
  base: string
  headOid?: string
  author?: string
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  isCrossRepository?: boolean
  checks?: Array<Check>
  comments?: Array<Comment>
  reviews?: Array<Review>
  diff?: string
  stack?: number | null
  merged_at?: string | null
  mergeMethod?: string
  autoMerge?: boolean
  deletedBranch?: boolean
  mergeAsync?: string
  mergeAsyncPending?: boolean
  reviewThreads?: Array<Thread>
  threadsPage?: number
  unreadable?: string
}
interface Issue {
  number: number
  title: string
  body: string
  state: string
  author?: string
  labels?: Array<string>
  comments?: Array<Comment>
}
interface Run {
  databaseId: number
  workflowName?: string
  displayTitle?: string
  headBranch?: string
  event?: string
  status?: string
  conclusion?: string
  url?: string
  createdAt?: string
  log?: string
}
interface Repo {
  default_branch?: string
  pulls?: Array<Pull>
  issues?: Array<Issue>
  runs?: Array<Run>
  stacks?: Record<string, Array<number>>
  jobs?: Record<string, string>
}
interface Route {
  stdout?: string
  stderr?: string
  code?: number
  json?: unknown
}
interface State {
  accounts?: Array<Account>
  defaultRepo?: string | null
  repos?: Record<string, Repo>
  help?: Record<string, string>
  routes?: Record<string, Route>
  calls?: Array<Json>
}

const NOW = "2026-11-12T00:00:00Z"
const env = process.env
const argv = process.argv.slice(2)
const statePath = env["HUNTAWAY_FAKE_GH_STATE"]

/** Fails the call as gh does: a message on stderr and an exit code (1). */
class Failure extends Error {
  readonly code: number
  constructor(message: string, code = 1) {
    super(message)
    this.code = code
  }
}
const fail = (message: string, code = 1): never => {
  throw new Failure(message, code)
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs `f` over the state, holding the lock (a folder beside the file), and writes it back (renamed into place). */
const withState = <A>(f: (state: State) => A): A => {
  if (statePath === undefined) return fail("fake gh: HUNTAWAY_FAKE_GH_STATE isn't set")
  const lock = `${statePath}.lock`
  let held = false
  for (let i = 0; i < 1000 && !held; i++) {
    try {
      mkdirSync(lock)
      held = true
    } catch {
      sleepSync(5)
    }
  }
  if (!held) return fail(`fake gh: ${lock} is held`)
  try {
    const state: State = JSON.parse(readFileSync(statePath, "utf8"))
    try {
      return f(state)
    } finally {
      const tmp = `${statePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(tmp, statePath)
    }
  } finally {
    rmdirSync(lock)
  }
}

// ---- Arguments

/** Flags that take no value. */
const BOOLEAN = new Set([
  "draft",
  "fill",
  "comments",
  "name-only",
  "merge",
  "squash",
  "rebase",
  "auto",
  "delete-branch",
  "paginate",
  "log-failed",
  "web",
  "include",
  "help",
  "version",
  "admin",
  "force",
  "silent",
])
const SHORT: Record<string, string> = { R: "repo", X: "method", f: "raw-field", F: "field", q: "jq", b: "body", t: "title", B: "base", s: "state", L: "limit" }

interface Parsed {
  positional: Array<string>
  flags: Map<string, Array<string>>
}

const parseArgs = (args: Array<string>, api: boolean): Parsed => {
  const positional: Array<string> = []
  const flags = new Map<string, Array<string>>()
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v])
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""
    if (a === "--") {
      positional.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      if (eq >= 0) add(name, a.slice(eq + 1))
      else if (BOOLEAN.has(name)) add(name, "true")
      else add(name, args[++i] ?? "")
    } else if (a.startsWith("-") && a.length > 1) {
      const letter = a[1] ?? ""
      const name = api && letter === "H" ? "header" : (SHORT[letter] ?? letter)
      const rest = a.slice(2)
      if (BOOLEAN.has(name)) add(name, "true")
      else add(name, rest !== "" ? (rest.startsWith("=") ? rest.slice(1) : rest) : (args[++i] ?? ""))
    } else positional.push(a)
  }
  return { positional, flags }
}

const one = (p: Parsed, k: string): string | null => p.flags.get(k)?.[0] ?? null
const yes = (p: Parsed, k: string) => p.flags.has(k)

// ---- Who and where

/** The account a call acts as: the one whose token is in GH_CONFIG_DIR's hosts.yml, else the host's active one. */
const actingAs = (state: State): Account | null => {
  const accounts = state.accounts ?? []
  const dir = env["GH_CONFIG_DIR"]
  if (dir !== undefined && dir !== "") {
    let hosts = ""
    try {
      hosts = readFileSync(`${dir}/hosts.yml`, "utf8")
    } catch {
      return fail("HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login", 1)
    }
    const token = /oauth_token: "([^"]*)"/.exec(hosts)?.[1]
    const found = accounts.find((a) => a.token === token)
    return found ?? fail("HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login")
  }
  const host = env["GH_HOST"] ?? "github.com"
  return accounts.find((a) => a.host === host && a.active === true) ?? accounts.find((a) => a.host === host) ?? null
}

const git = (args: Array<string>): string | null => {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

/** `OWNER/REPO` (github.com) or `HOST/OWNER/REPO` from a remote URL or a `[HOST/]OWNER/REPO`. */
const repoKey = (given: string): string | null => {
  let s = given.trim().replace(/\.git$/, "")
  const url = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)\/?$/i.exec(s)
  if (url !== null) return url[1]?.toLowerCase() === "github.com" ? `${url[2]}/${url[3]}` : `${url[1]?.toLowerCase()}/${url[2]}/${url[3]}`
  const scp = /^(?:[^@]*@)?([^:/]+):([^/]+)\/([^/]+)$/.exec(s)
  if (scp !== null) return scp[1] === "github.com" ? `${scp[2]}/${scp[3]}` : `${scp[1]}/${scp[2]}/${scp[3]}`
  if (s.startsWith("github.com/")) s = s.slice("github.com/".length)
  return /^[^/]+\/[^/]+(\/[^/]+)?$/.test(s) ? s : null
}

const repoOf = (state: State, p: Parsed): string => {
  const given = one(p, "repo") ?? (env["GH_REPO"] !== undefined && env["GH_REPO"] !== "" ? env["GH_REPO"] : null)
  if (given !== null) return repoKey(given) ?? fail(`expected the "[HOST/]OWNER/REPO" format, got "${given}"`)
  const origin = git(["remote", "get-url", "origin"])
  const fromOrigin = origin === null ? null : repoKey(origin)
  if (fromOrigin !== null) return fromOrigin
  return state.defaultRepo ?? fail("could not determine base repo: no git remotes found")
}

const repoIn = (state: State, key: string): Repo => {
  state.repos ??= {}
  const repo = state.repos[key] ?? fail(`GraphQL: Could not resolve to a Repository with the name '${key}'. (repository)`)
  return repo
}

const webHost = (key: string) => (key.split("/").length === 3 ? key.split("/")[0] : "github.com")
const ownerName = (key: string) => key.split("/").slice(-2).join("/")
const prUrl = (key: string, n: number) => `https://${webHost(key)}/${ownerName(key)}/pull/${n}`

// ---- Output

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

/** `--json fields` of `value` (all of it with none), then `--jq`'s path. */
const shown = (p: Parsed, value: unknown, pick: (v: unknown, fields: Array<string>) => unknown): string => {
  const fields = one(p, "json")
  let out =
    fields === null
      ? value
      : pick(
          value,
          fields.split(",").filter((f) => f !== ""),
        )
  const jq = one(p, "jq")
  if (jq !== null) {
    for (const k of jq.split(".").filter((x) => x !== "")) out = typeof out === "object" && out !== null ? (Reflect.get(out, k) as unknown) : undefined
    return typeof out === "string" ? `${out}\n` : json(out ?? null)
  }
  return json(out)
}

const pickFields = (v: unknown, fields: Array<string>): unknown => {
  if (Array.isArray(v)) return v.map((x) => pickFields(x, fields))
  const o: object = typeof v === "object" && v !== null ? v : {}
  return Object.fromEntries(fields.map((f): [string, unknown] => [f, (Reflect.get(o, f) as unknown) ?? null]))
}

const checkRun = (c: Check) => ({
  __typename: "CheckRun",
  name: c.name,
  status: c.bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
  conclusion: c.bucket === "pass" ? "SUCCESS" : c.bucket === "fail" ? "FAILURE" : c.bucket === "skipping" ? "SKIPPED" : "",
  workflowName: c.workflow ?? "",
  detailsUrl: c.link ?? "",
  startedAt: c.startedAt ?? NOW,
  completedAt: c.completedAt ?? (c.bucket === "pending" ? null : NOW),
})

/** A pull request as `gh pr view --json` has it. */
const prView = (key: string, pr: Pull) => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  state: pr.state,
  isDraft: pr.isDraft ?? false,
  url: prUrl(key, pr.number),
  author: { login: pr.author ?? "" },
  headRefName: pr.head,
  baseRefName: pr.base,
  headRefOid: pr.headOid ?? "0000000000000000000000000000000000000000",
  isCrossRepository: pr.isCrossRepository ?? false,
  mergeable: pr.mergeable ?? "MERGEABLE",
  mergeStateStatus: pr.mergeStateStatus ?? (pr.mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN"),
  reviewDecision: pr.reviewDecision ?? "",
  statusCheckRollup: (pr.checks ?? []).map(checkRun),
  comments: (pr.comments ?? []).map((c) => ({
    author: { login: c.author },
    body: c.body,
    createdAt: c.createdAt ?? NOW,
    authorAssociation: c.authorAssociation ?? "NONE",
  })),
  reviews: (pr.reviews ?? []).map((r) => ({
    author: { login: r.author },
    state: r.state,
    body: r.body ?? "",
    submittedAt: r.submittedAt ?? NOW,
    authorAssociation: r.authorAssociation ?? "NONE",
  })),
  updatedAt: NOW,
  mergedAt: pr.merged_at ?? null,
  closed: pr.state !== "OPEN",
})

/** A pull request as GitHub's REST API has it. */
const prRest = (key: string, pr: Pull) => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  state: pr.state === "OPEN" ? "open" : "closed",
  merged: pr.state === "MERGED",
  merged_at: pr.merged_at ?? null,
  html_url: prUrl(key, pr.number),
  head: { ref: pr.head, sha: pr.headOid ?? "0000000000000000000000000000000000000000" },
  base: { ref: pr.base },
  draft: pr.isDraft ?? false,
  stack: pr.stack === null || pr.stack === undefined ? null : { number: pr.stack },
})

// ---- Pull requests

const pulls = (repo: Repo) => (repo.pulls ??= [])

const currentBranch = () => git(["symbolic-ref", "--short", "HEAD"])

/** The pull request a `pr` command names (number, URL or branch; the current branch's with none). */
const findPr = (state: State, p: Parsed, target: string | undefined): { key: string; pr: Pull } => {
  let key = repoOf(state, p)
  let ref = target
  const url = ref === undefined ? null : /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(ref)
  if (url !== null) {
    key = url[1] === "github.com" ? `${url[2]}/${url[3]}` : `${url[1]}/${url[2]}/${url[3]}`
    ref = url[4]
  }
  const repo = repoIn(state, key)
  if (ref !== undefined && /^\d+$/.test(ref)) {
    const n = Number(ref)
    const pr = pulls(repo).find((x) => x.number === n)
    return pr === undefined ? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`) : { key, pr }
  }
  const branch = ref ?? currentBranch() ?? fail("could not determine the current branch")
  const all = pulls(repo).filter((x) => x.head === branch)
  const pr = all.find((x) => x.state === "OPEN") ?? all.at(-1)
  return pr === undefined ? fail(`no pull requests found for branch "${branch}"`) : { key, pr }
}

const prCommand = (state: State, as: Account | null, sub: string | undefined, p: Parsed): string => {
  const target = p.positional[2]
  switch (sub ?? "") {
    case "create": {
      const key = repoOf(state, p)
      const repo = repoIn(state, key)
      const head = one(p, "head") ?? currentBranch() ?? fail("could not determine the current branch")
      const base = one(p, "base") ?? repo.default_branch ?? "main"
      const open = pulls(repo).find((x) => x.head === head && x.base === base && x.state === "OPEN")
      if (open !== undefined) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${prUrl(key, open.number)}`)
      const title = one(p, "title") ?? (yes(p, "fill") ? head : fail("must provide `--title` and `--body` (or `--fill`) when not running interactively"))
      const number = Math.max(0, ...pulls(repo).map((x) => x.number), ...(repo.issues ?? []).map((x) => x.number)) + 1
      const headOid = git(["rev-parse", head]) ?? undefined
      pulls(repo).push({
        number,
        title,
        body: one(p, "body") ?? "",
        state: "OPEN",
        isDraft: yes(p, "draft"),
        head,
        base,
        ...(headOid === undefined ? {} : { headOid }),
        author: as?.login ?? "",
        checks: [],
        comments: [],
        reviews: [],
        stack: null,
        merged_at: null,
      })
      return `${prUrl(key, number)}\n`
    }
    case "view": {
      const { key, pr } = findPr(state, p, target)
      return shown(p, prView(key, pr), pickFields)
    }
    case "list": {
      const key = repoOf(state, p)
      const want = (one(p, "state") ?? "open").toUpperCase()
      const list = pulls(repoIn(state, key))
        .filter((x) => want === "ALL" || x.state === want)
        .filter((x) => (one(p, "head") ?? x.head) === x.head && (one(p, "base") ?? x.base) === x.base)
        .filter((x) => {
          const author = one(p, "author")
          return author === null || (author === "@me" ? x.author === as?.login : x.author === author)
        })
        .toReversed()
        .slice(0, Number(one(p, "limit") ?? 30))
        .map((x) => prView(key, x))
      return shown(p, list, pickFields)
    }
    case "checks": {
      const { pr } = findPr(state, p, target)
      const checks = pr.checks ?? []
      if (checks.length === 0) fail(`no checks reported on the '${pr.head}' branch`)
      const out = shown(p, checks, pickFields)
      if (checks.some((c) => c.bucket === "pending")) throw new Failure(out, 8)
      return out
    }
    case "diff": {
      const { pr } = findPr(state, p, target)
      const diff = pr.diff ?? ""
      if (!yes(p, "name-only")) return diff
      return [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => `${m[1]}\n`).join("")
    }
    case "comment": {
      const { key, pr } = findPr(state, p, target)
      ;(pr.comments ??= []).push({ author: as?.login ?? "", body: one(p, "body") ?? fail("--body required when not running interactively"), createdAt: NOW })
      return `${prUrl(key, pr.number)}#issuecomment-${pr.comments.length}\n`
    }
    case "edit": {
      const { key, pr } = findPr(state, p, target)
      pr.title = one(p, "title") ?? pr.title
      pr.body = one(p, "body") ?? pr.body
      pr.base = one(p, "base") ?? pr.base
      return `${prUrl(key, pr.number)}\n`
    }
    case "merge": {
      const { pr } = findPr(state, p, target)
      if (pr.state !== "OPEN") fail(`Pull request #${pr.number} (${pr.title}) can't be merged: it is ${pr.state.toLowerCase()}`)
      if (pr.stack !== null && pr.stack !== undefined)
        fail(`GraphQL: Pull request #${pr.number} is in a stack: merge it with the merge-async API (mergePullRequest)`)
      if (pr.mergeable === "CONFLICTING") fail(`Pull request #${pr.number} is not mergeable: the merge commit cannot be cleanly created.`)
      const method = yes(p, "squash") ? "squash" : yes(p, "rebase") ? "rebase" : "merge"
      if (yes(p, "auto")) {
        pr.autoMerge = true
        pr.mergeMethod = method
        return `✓ Pull request #${pr.number} will be automatically merged via ${method} when all requirements are met\n`
      }
      pr.state = "MERGED"
      pr.merged_at = NOW
      pr.mergeMethod = method
      if (yes(p, "delete-branch")) pr.deletedBranch = true
      return `✓ Merged pull request #${pr.number} (${pr.title})\n`
    }
    case "close": {
      const { pr } = findPr(state, p, target)
      pr.state = "CLOSED"
      return `✓ Closed pull request #${pr.number} (${pr.title})\n`
    }
    default:
      return fail(`unknown command "${sub ?? ""}" for "gh pr"`)
  }
}

// ---- Issues and runs

const issueCommand = (state: State, as: Account | null, sub: string | undefined, p: Parsed): string => {
  const key = repoOf(state, p)
  const repo = repoIn(state, key)
  const issues = (repo.issues ??= [])
  const find = (ref: string | undefined) => {
    const n = Number(/(\d+)$/.exec(ref ?? "")?.[1] ?? Number.NaN)
    return (
      issues.find((x) => x.number === n) ?? fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${ref ?? ""}. (repository.issue)`)
    )
  }
  const view = (x: Issue) => ({
    number: x.number,
    title: x.title,
    body: x.body,
    state: x.state,
    url: `https://${webHost(key)}/${ownerName(key)}/issues/${x.number}`,
    author: { login: x.author ?? "" },
    assignees: [],
    labels: (x.labels ?? []).map((name) => ({ name })),
    comments: (x.comments ?? []).map((c) => ({ author: { login: c.author }, body: c.body })),
    createdAt: NOW,
    updatedAt: NOW,
  })
  switch (sub ?? "") {
    case "view":
      return shown(p, view(find(p.positional[2])), pickFields)
    case "list": {
      const want = (one(p, "state") ?? "open").toUpperCase()
      return shown(p, issues.filter((x) => want === "ALL" || x.state === want).map(view), pickFields)
    }
    case "create": {
      const number = Math.max(0, ...issues.map((x) => x.number), ...pulls(repo).map((x) => x.number)) + 1
      issues.push({
        number,
        title: one(p, "title") ?? fail("must provide `--title`"),
        body: one(p, "body") ?? "",
        state: "OPEN",
        author: as?.login ?? "",
        labels: p.flags.get("label") ?? [],
      })
      return `https://${webHost(key)}/${ownerName(key)}/issues/${number}\n`
    }
    case "comment": {
      const issue = find(p.positional[2])
      ;(issue.comments ??= []).push({ author: as?.login ?? "", body: one(p, "body") ?? fail("--body required") })
      return `https://${webHost(key)}/${ownerName(key)}/issues/${issue.number}#issuecomment-${issue.comments.length}\n`
    }
    default:
      return fail(`unknown command "${sub ?? ""}" for "gh issue"`)
  }
}

const runCommand = (state: State, sub: string | undefined, p: Parsed): string => {
  const runs = repoIn(state, repoOf(state, p)).runs ?? []
  if (sub === "list") {
    const list = runs
      .filter((r) => (one(p, "branch") ?? r.headBranch) === r.headBranch && (one(p, "workflow") ?? r.workflowName) === r.workflowName)
      .slice(0, Number(one(p, "limit") ?? 20))
    return shown(p, list, pickFields)
  }
  if (sub === "view" && one(p, "job") !== null) {
    const job = one(p, "job") ?? ""
    const log = repoIn(state, repoOf(state, p)).jobs?.[job]
    return log ?? fail(`HTTP 404: Not Found (https://api.github.com/repos/jobs/${job})`)
  }
  if (sub === "view") {
    const id = Number(p.positional[2] ?? Number.NaN)
    const run = runs.find((r) => r.databaseId === id) ?? fail(`HTTP 404: Not Found (https://api.github.com/repos/run/${id})`)
    if (yes(p, "log-failed")) return run.log ?? ""
    return `${run.workflowName ?? ""} · ${run.databaseId}\n${run.status ?? ""} ${run.conclusion ?? ""}\n`
  }
  return fail(`unknown command "${sub ?? ""}" for "gh run"`)
}

// ---- The REST and GraphQL API

/** `--raw-field`/`-f` and `--field`/`-F` as a request's parameters (`-F` values parsed as JSON scalars). */
const fieldsOf = (p: Parsed): Json => {
  const out: Json = {}
  for (const f of p.flags.get("raw-field") ?? []) out[f.slice(0, f.indexOf("="))] = f.slice(f.indexOf("=") + 1)
  for (const f of p.flags.get("field") ?? []) {
    const v = f.slice(f.indexOf("=") + 1)
    let parsed: unknown = v
    try {
      parsed = JSON.parse(v)
    } catch {
      // A string.
    }
    out[f.slice(0, f.indexOf("="))] = parsed
  }
  return out
}

/** A string as it is, a number or boolean as text, anything else "". */
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "")

const merge = (pr: Pull, method: string) => {
  pr.state = "MERGED"
  pr.merged_at = NOW
  pr.mergeMethod = method
  pr.mergeAsyncPending = false
}

/** A check as GraphQL's `statusCheckRollup.contexts` has it: a check run (of a workflow's job, with its suite), or a status. */
const contextNode = (c: Check, i: number) => {
  if (c.kind === "status") {
    const state = c.bucket === "pass" ? "SUCCESS" : c.bucket === "fail" ? "FAILURE" : "PENDING"
    return { __typename: "StatusContext", context: c.name, state, targetUrl: c.link ?? null, createdAt: c.startedAt ?? NOW, isRequired: c.required ?? false }
  }
  const pending = c.bucket === "pending"
  const conclusion = c.conclusion ?? (c.bucket === "pass" ? "SUCCESS" : c.bucket === "fail" ? "FAILURE" : c.bucket === "skipping" ? "SKIPPED" : null)
  return {
    __typename: "CheckRun",
    databaseId: c.id ?? 1000 + i,
    name: c.name,
    status: pending ? "IN_PROGRESS" : "COMPLETED",
    conclusion: pending ? null : conclusion,
    detailsUrl: c.link ?? null,
    isRequired: c.required ?? false,
    checkSuite:
      c.workflow === undefined
        ? null
        : { databaseId: c.suite?.id ?? 1, status: c.suite?.status ?? (pending ? "IN_PROGRESS" : "COMPLETED"), workflowRun: { workflow: { name: c.workflow } } },
  }
}

const authorNode = (login: string, bot: boolean | undefined) => ({ __typename: bot === true ? "Bot" : "User", login })

/** A pull request's review threads from `after` (a page's cursor: the index of its first), `page` at a time. */
const threadsOf = (key: string, pr: Pull, after: string | null) => {
  const all = pr.reviewThreads ?? []
  const size = pr.threadsPage ?? 100
  const start = after === null ? 0 : Number(after)
  const nodes = all.slice(start, start + size).map((t, i) => ({
    path: t.path,
    comments: {
      nodes: t.comments.map((c, j) => ({
        id: c.id ?? `t${start + i}c${j}`,
        author: authorNode(c.author, c.bot),
        authorAssociation: c.authorAssociation ?? "NONE",
        body: c.body,
        url: c.url ?? `${prUrl(key, pr.number)}#discussion_t${start + i}c${j}`,
        createdAt: c.createdAt ?? NOW,
        path: t.path,
        line: c.line ?? null,
        originalLine: c.line ?? null,
      })),
    },
  }))
  const next = start + size
  return { pageInfo: { hasNextPage: next < all.length, endCursor: next < all.length ? String(next) : null }, nodes }
}

/** A pull request as `PrWatch`'s query has it (huntaway-server's github/prWatch/pr.ts `QUERY`). */
const prNode = (key: string, pr: Pull, after: string | null) => {
  const view = prView(key, pr)
  return {
    url: view.url,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: view.isDraft,
    baseRefName: pr.base,
    headRefOid: view.headRefOid,
    mergeable: view.mergeable,
    mergeStateStatus: view.mergeStateStatus,
    reviewDecision: pr.reviewDecision ?? null,
    commits: { nodes: [{ commit: { oid: view.headRefOid, statusCheckRollup: { contexts: { nodes: (pr.checks ?? []).map(contextNode) } } } }] },
    comments: {
      nodes: (pr.comments ?? []).map((c, i) => ({
        id: c.id ?? `c${i}`,
        author: authorNode(c.author, c.bot),
        authorAssociation: c.authorAssociation ?? "NONE",
        body: c.body,
        url: c.url ?? `${view.url}#issuecomment-${i + 1}`,
        createdAt: c.createdAt ?? NOW,
      })),
    },
    reviews: {
      nodes: (pr.reviews ?? []).map((r, i) => ({
        id: r.id ?? `r${i}`,
        author: authorNode(r.author, r.bot),
        authorAssociation: r.authorAssociation ?? "NONE",
        state: r.state,
        body: r.body ?? "",
        url: r.url ?? `${view.url}#pullrequestreview-${i + 1}`,
        submittedAt: r.submittedAt ?? NOW,
      })),
    },
    reviewThreads: threadsOf(key, pr, after),
  }
}

/**
 * `api graphql`: a pull request by `owner`, `name` and `number` (its review threads after `after`, for a page past
 * the first), or many pull requests' states at once (`o0`, `n0`, `p0`…, aliased `pr0`…), as the board asks. A pull
 * request with `unreadable` fails the query with that message.
 */
const graphql = (state: State, as: Account | null, p: Parsed): unknown => {
  const vars = fieldsOf(p)
  const host = one(p, "hostname") ?? env["GH_HOST"] ?? "github.com"
  const keyOf = (owner: string, name: string) => (host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`)
  if (vars["o0"] !== undefined) {
    const data: Record<string, unknown> = {}
    const errors: Array<{ message: string }> = []
    for (let i = 0; vars[`o${i}`] !== undefined; i++) {
      const key = keyOf(str(vars[`o${i}`]), str(vars[`n${i}`]))
      const n = Number(vars[`p${i}`])
      const pr = state.repos?.[key]?.pulls?.find((x) => x.number === n)
      if (pr?.unreadable !== undefined) return fail(pr.unreadable)
      if (pr === undefined) {
        errors.push({ message: `Could not resolve to a PullRequest with the number of ${n}.` })
        data[`pr${i}`] = { pullRequest: null }
        continue
      }
      const node = prNode(key, pr, null)
      data[`pr${i}`] = { pullRequest: { state: node.state, headRefOid: node.headRefOid, commits: node.commits } }
    }
    return errors.length === 0 ? { data } : { data, errors }
  }
  const key = keyOf(str(vars["owner"]), str(vars["name"] ?? vars["repo"]))
  const repo = repoIn(state, key)
  const n = Number(vars["number"])
  const pr = pulls(repo).find((x) => x.number === n) ?? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`)
  if (pr.unreadable !== undefined) return fail(pr.unreadable)
  const after = vars["after"] === undefined ? null : str(vars["after"])
  if (after !== null) return { data: { repository: { pullRequest: { reviewThreads: threadsOf(key, pr, after) } } } }
  return { data: { viewer: { login: as?.login ?? "" }, repository: { pullRequest: prNode(key, pr, null) } } }
}

const apiCommand = (state: State, as: Account | null, p: Parsed): string => {
  const endpointGiven = p.positional[1] ?? fail("must pass an endpoint")
  const fields = fieldsOf(p)
  const method = (one(p, "method") ?? (Object.keys(fields).length > 0 ? "POST" : "GET")).toUpperCase()
  const out = (v: unknown) => shown({ positional: [], flags: new Map(p.flags.has("jq") ? [["jq", p.flags.get("jq") ?? []]] : []) }, v, pickFields)
  if (endpointGiven === "graphql") return out(graphql(state, as, p))
  let endpoint = endpointGiven.replace(/^\//, "")
  if (endpoint.includes("{owner}") || endpoint.includes("{repo}")) {
    const [owner, name] = ownerName(repoOf(state, p)).split("/")
    endpoint = endpoint.replaceAll("{owner}", owner ?? "").replaceAll("{repo}", name ?? "")
  }
  const host = one(p, "hostname")
  const keyOf = (o: string, r: string) => (host === null || host === "github.com" ? `${o}/${r}` : `${host}/${o}/${r}`)
  if (endpoint === "user") return out({ login: as?.login ?? "" })
  const m = /^repos\/([^/]+)\/([^/]+)(?:\/(pulls|stacks)\/(\d+)(?:\/(merge|merge-async)(?:\/([^/]+))?)?)?$/.exec(endpoint)
  if (m === null) return fail("gh: Not Found (HTTP 404)")
  const key = keyOf(m[1] ?? "", m[2] ?? "")
  const repo = repoIn(state, key)
  if (m[3] === undefined) return out({ full_name: ownerName(key), default_branch: repo.default_branch ?? "main" })
  const n = Number(m[4])
  if (m[3] === "stacks") {
    const list = repo.stacks?.[String(n)] ?? fail("gh: Not Found (HTTP 404)")
    return out({
      number: n,
      pull_requests: list.map((k) => {
        const pr = pulls(repo).find((x) => x.number === k)
        return { number: k, state: pr?.state === "OPEN" ? "open" : "closed", merged_at: pr?.merged_at ?? null }
      }),
    })
  }
  const pr = pulls(repo).find((x) => x.number === n) ?? fail("gh: Not Found (HTTP 404)")
  if (m[5] === undefined) {
    if (method === "PATCH") {
      if (typeof fields["title"] === "string") pr.title = fields["title"]
      if (typeof fields["body"] === "string") pr.body = fields["body"]
      if (typeof fields["base"] === "string") pr.base = fields["base"]
      if (fields["state"] === "closed") pr.state = "CLOSED"
    }
    return out(prRest(key, pr))
  }
  if (m[5] === "merge") {
    if (method !== "PUT") return fail("gh: Not Found (HTTP 404)")
    if (pr.state !== "OPEN") return fail("gh: Pull Request is not mergeable (HTTP 405)")
    merge(pr, str(fields["merge_method"]) || "merge")
    return out({ merged: true, message: "Pull Request successfully merged" })
  }
  // merge-async: PUT starts it, GET of its id says how it went.
  if (m[6] !== undefined) {
    if (pr.mergeAsyncPending === true) merge(pr, pr.mergeMethod ?? "merge")
    return out({ status: pr.state === "MERGED" ? "merged" : "failed", details: pr.state === "MERGED" ? { sha: pr.headOid ?? "" } : { message: "not merged" } })
  }
  if (method !== "PUT") return fail("gh: Not Found (HTTP 404)")
  const how = pr.mergeAsync ?? "merged"
  const mergeMethod = str(fields["merge_method"]) || "merge"
  if (how === "failed") return out({ status: "failed", details: { message: "Merge conflict" } })
  if (how === "pending") {
    pr.mergeAsyncPending = true
    pr.mergeMethod = mergeMethod
    return out({ status: "pending", details: { uuid: `u${pr.number}` } })
  }
  merge(pr, mergeMethod)
  return out({ status: "merged", details: { sha: pr.headOid ?? "" } })
}

// ---- The rest

const authCommand = (state: State, sub: string | undefined, p: Parsed): string => {
  const accounts = state.accounts ?? []
  if (sub === "token") {
    const host = one(p, "hostname") ?? "github.com"
    const user = one(p, "user")
    const found = accounts.find((a) => a.host === host && (user === null ? a.active === true : a.login === user))
    if (found === undefined) return fail(`no oauth token found for ${host}${user === null ? "" : ` account ${user}`}`)
    return `${found.token}\n`
  }
  if (sub === "status") {
    const hosts: Record<string, Array<Json>> = {}
    for (const a of accounts) (hosts[a.host] ??= []).push({ login: a.login, active: a.active === true, state: "success", host: a.host })
    return json({ hosts })
  }
  return fail(`unknown command "${sub ?? ""}" for "gh auth"`)
}

const repoCommand = (state: State, sub: string | undefined, p: Parsed): string => {
  if (sub !== "view") return fail(`unknown command "${sub ?? ""}" for "gh repo"`)
  const key = p.positional[2] === undefined ? repoOf(state, p) : (repoKey(p.positional[2]) ?? fail("bad repository"))
  const repo = repoIn(state, key)
  return shown(
    p,
    { nameWithOwner: ownerName(key), defaultBranchRef: { name: repo.default_branch ?? "main" }, url: `https://${webHost(key)}/${ownerName(key)}` },
    pickFields,
  )
}

const answer = (state: State): string => {
  const route = state.routes?.[argv.join(" ")]
  if (route !== undefined) {
    const stdout = route.json === undefined ? (route.stdout ?? "") : json(route.json)
    if (route.code !== undefined && route.code !== 0) {
      process.stdout.write(stdout)
      throw new Failure(route.stderr ?? "", route.code)
    }
    if (route.stderr !== undefined) process.stderr.write(route.stderr)
    return stdout
  }
  if (argv[0] === "--version") return "gh version 2.0.0 (fake)\n"
  if (argv.includes("--help") || argv.includes("-h")) {
    const words = argv.filter((a) => !a.startsWith("-"))
    const help = state.help?.[`${words[0] ?? ""} ${words[1] ?? ""}`] ?? state.help?.[words[0] ?? ""]
    return help ?? fail(`unknown command "${words.join(" ")}" for "gh"`)
  }
  const [command, sub] = argv
  const p = parseArgs(argv, command === "api")
  if (command === "auth") return authCommand(state, sub, p)
  const as = actingAs(state)
  switch (command ?? "") {
    case "pr":
      return prCommand(state, as, sub, p)
    case "issue":
      return issueCommand(state, as, sub, p)
    case "run":
      return runCommand(state, sub, p)
    case "api":
      return apiCommand(state, as, p)
    case "repo":
      return repoCommand(state, sub, p)
    default:
      return fail(`unknown command "${command ?? ""}" for "gh"`)
  }
}

/** The modes of GH_CONFIG_DIR and its hosts.yml (octal), if it has one. */
const configModes = (): Array<string> | null => {
  const dir = env["GH_CONFIG_DIR"]
  if (dir === undefined || dir === "") return null
  try {
    return [dir, `${dir}/hosts.yml`].map((path) => (statSync(path).mode & 0o777).toString(8))
  } catch {
    return null
  }
}

const main = (): number => {
  try {
    const out = withState((state) => {
      // The account, read before answering: the token in its environment is what the board gave it.
      let as: string | null = null
      try {
        as = argv[0] === "auth" ? null : (actingAs(state)?.login ?? null)
      } catch {
        as = null
      }
      ;(state.calls ??= []).push({
        args: argv,
        cwd: process.cwd(),
        as,
        host: env["GH_HOST"] ?? null,
        repo: env["GH_REPO"] ?? null,
        envToken: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].some((v) => (env[v] ?? "") !== ""),
        configDir: env["GH_CONFIG_DIR"] ?? null,
        configModes: configModes(),
        dbus: env["DBUS_SESSION_BUS_ADDRESS"] ?? null,
      })
      return answer(state)
    })
    process.stdout.write(out)
    return 0
  } catch (e) {
    if (e instanceof Failure) {
      if (e.code === 8) process.stdout.write(e.message)
      else process.stderr.write(e.message.endsWith("\n") || e.message === "" ? e.message : `${e.message}\n`)
      return e.code
    }
    process.stderr.write(`fake gh: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

process.exitCode = main()
