import { Option, Result, Schema } from "effect"
import type { PrChecks } from "@huntaway/contracts"
import { prNote } from "../../prompts/pullRequests.ts"
import type { NewsComment, NewsFailed } from "../../prompts/pullRequests.ts"

// A pull request as one read finds it (huntaway's mcp/pr_watch/pr.ts): the GraphQL query and its answer read leniently
// (`QUERY`, `parsePr`, `checksOf`), how its checks stand, and what in it is news to an agent that was told `seen`
// (`compare`). Plain functions.

/** What can end a wait on a pull request, besides its being merged or closed. */
export const EVENTS = ["checks_failed", "checks_passed", "comments", "conflicts"] as const
export type PrEvent = (typeof EVENTS)[number]

/**
 * What every wait on a pull request ends on, whatever `pull_request_events` names (HA-300): an agent that waited on
 * checks alone sat until its timeout when the pull request conflicted, so `pull_request_events` only adds to these.
 */
export const ALWAYS: ReadonlyArray<PrEvent> = ["checks_failed", "checks_passed", "conflicts"]

/** The most comments a wait lists, and how much of each one's text. */
export const LISTED = 20
export const BODY_MAX = 800

/**
 * How many comment ids are kept as seen (the reads see the latest ones only), besides those the latest read still
 * sees, which are always kept (see `compare`).
 */
export const SEEN_MAX = 2000

/** The most pages of review threads (100 each) a read goes through. */
export const THREAD_PAGES = 10

/**
 * The review threads a read gets (100 at a time, the oldest first, so that new ones on a busy pull request are on later
 * pages), with the latest comments of each.
 */
const threadsField = (args: string) =>
  `reviewThreads(first: 100${args}) { pageInfo { hasNextPage endCursor } nodes { path comments(last: 20) { nodes { id author { __typename login } authorAssociation body url createdAt path line originalLine } } } }`

/** A pull request's head commit's checks (see `checksOf`), for a query whose pull request's number is `$number`. */
const CHECKS_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { databaseId status workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }`

/** The fields of a pull request that `checksOf` reads (with `headRefOid`), for another query whose pull request's number is `$number`. */
export const CHECKS = `headRefOid ${CHECKS_FIELDS}`

/**
 * The query a read makes: the pull request's state, its head commit's checks, and its latest comments, reviews and
 * review comments, with who's asking (`viewer`).
 */
export const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision
      ${CHECKS_FIELDS}
      comments(last: 50) { nodes { id author { __typename login } authorAssociation body url createdAt } }
      reviews(last: 50) { nodes { id author { __typename login } authorAssociation state body url submittedAt } }
      ${threadsField("")}
    }
  }
}`

/** The query for the review threads after the first page's. */
export const THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${threadsField(", after: $after")}
    }
  }
}`

// ---- reading an answer leniently ---------------------------------------------------------------------------------

type JsonObject = Readonly<Record<string, unknown>>
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const isArray = Schema.is(Schema.Array(Schema.Unknown))

/** `v` if it's an object, else an empty one. */
export const obj = (v: unknown): JsonObject => (isObject(v) && !isArray(v) ? v : {})
/** `v` if it's an object, else null. */
export const objOrNull = (v: unknown): JsonObject | null => (isObject(v) && !isArray(v) ? v : null)
const arr = (v: unknown): ReadonlyArray<unknown> => (isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const lower = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null)
const u64 = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null)
const nodes = (v: unknown): ReadonlyArray<unknown> => arr(obj(v)["nodes"])
/** `v.a.b…`, leniently. */
export const at = (v: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((x, k) => (typeof k === "number" ? arr(x)[k] : obj(x)[k]), v)

// ---- checks ------------------------------------------------------------------------------------------------------

export type CheckState = "Pending" | "Passed" | "Failed"

export interface Check {
  /** One run of it: a check run's id, or a status's context and time. */
  readonly key: string
  readonly name: string
  readonly state: CheckState
  /** How it ended (`failure`, `cancelled`…), or its status while it runs. */
  readonly conclusion: string
  readonly url: string | null
  readonly required: boolean
  /** The GitHub Actions job it is (a check run's id is its job's), whose log can be read. */
  readonly job: number | null
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"])

/** The checks of a pull request read with `CHECKS`. */
export const checksOf = (pr: unknown): Array<Check> => {
  const checks: Array<Check> = []
  // The workflow runs (check suites) that haven't ended, by id: their name, status, and whether one of their jobs is pending.
  const running = new Map<string, readonly [string, string, boolean]>()
  for (const node of arr(at(pr, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes"))) {
    const c = obj(node)
    const required = c["isRequired"] === true
    if (c["__typename"] === "CheckRun") {
      const status = lower(c["status"]) ?? ""
      const conclusion = lower(c["conclusion"]) ?? ""
      const state: CheckState = status !== "completed" ? "Pending" : FAILED.has(conclusion) ? "Failed" : "Passed"
      let name = str(c["name"]) ?? "check"
      const suite = obj(c["checkSuite"])
      const workflow = str(at(suite, "workflowRun", "workflow", "name"))
      if (workflow !== null && workflow !== "") name = `${workflow} / ${name}`
      const rawId = c["databaseId"]
      const id = u64(rawId) !== null ? String(rawId) : (str(rawId) ?? "")
      const job = objOrNull(suite["workflowRun"]) !== null && /^\+?[0-9]+$/.test(id) ? Number(id) : null
      checks.push({ key: `run:${id}`, name, state, conclusion: state === "Pending" ? status : conclusion, url: str(c["detailsUrl"]), required, job })
      const suiteStatus = lower(suite["status"])
      const suiteId = suite["databaseId"]
      const key = typeof suiteId === "string" || typeof suiteId === "number" ? String(suiteId) : null
      if (objOrNull(suite["workflowRun"]) !== null && key !== null && suiteStatus !== null && suiteStatus !== "completed") {
        const was = running.get(key)
        running.set(key, [workflow !== null && workflow !== "" ? workflow : "workflow", suiteStatus, (was?.[2] ?? false) || state === "Pending"])
      }
    } else if (c["__typename"] === "StatusContext") {
      const status = lower(c["state"]) ?? ""
      const state: CheckState = status === "success" ? "Passed" : status === "failure" || status === "error" ? "Failed" : "Pending"
      const name = str(c["context"]) ?? "status"
      checks.push({ key: `status:${name}:${str(c["createdAt"]) ?? ""}`, name, state, conclusion: status, url: str(c["targetUrl"]), required, job: null })
    }
  }
  // A workflow run makes a job's check only once the jobs it `needs` have ended, so one whose first job passed has, for
  // a moment, nothing but passed checks while the rest are still to start (a first job that decides whether the others
  // run, as this repository's `tree` does, makes that every run). Until the run ends, it's pending.
  for (const [id, [workflow, status, pending]] of running) {
    if (!pending) {
      checks.push({
        key: `suite:${id}`,
        name: `${workflow} / jobs still to start`,
        state: "Pending",
        conclusion: status,
        url: null,
        required: false,
        job: null,
      })
    }
  }
  return checks
}

/** Whether the checks that have to pass did: the required ones, or all of them if none is. */
export const passed = (checks: ReadonlyArray<Check>): boolean => {
  const required = checks.filter((c) => c.required)
  const gate = required.length > 0 ? required : checks
  return gate.length > 0 && gate.every((c) => c.state === "Passed")
}

/** How `checks` stand: `none`, `failed` (any of them), `passed` (see `passed`) or `pending`. */
export const outcome = (checks: ReadonlyArray<Check>): PrChecks["outcome"] => {
  if (checks.length === 0) return "none"
  if (checks.some((c) => c.state === "Failed")) return "failed"
  if (passed(checks)) return "passed"
  return "pending"
}

// ---- the pull request --------------------------------------------------------------------------------------------

/** A comment, review or review comment. */
export interface Remark {
  readonly id: string
  readonly author: string | null
  /** Whether a GitHub App (a bot) wrote it. */
  readonly bot: boolean
  /** Its author's association with the repository (owner, member, collaborator, contributor, none…), as GitHub has it. */
  readonly association: string | null
  readonly kind: "comment" | "review" | "review_comment"
  readonly review_state: string | null
  readonly path: string | null
  readonly line: number | null
  readonly body: string
  readonly url: string | null
  readonly at: string | null
}

/**
 * Whether its author can push to the repository (its owner, or a member or collaborator): only their comments wake an
 * agent whose task is in review.
 */
export const byMaintainer = (r: Remark): boolean => r.association === "owner" || r.association === "member" || r.association === "collaborator"

/** A review that only says it commented, whose comments say what it did. */
const isBareReview = (r: Remark): boolean => r.kind === "review" && r.review_state === "commented" && r.body.trim() === ""

/** A pull request as a read found it. */
export interface Pr {
  readonly viewer: string
  readonly url: string
  readonly number: number
  readonly title: string
  /** open, merged or closed. */
  readonly state: string
  readonly draft: boolean
  readonly base: string
  readonly head: string
  /** mergeable, conflicting or unknown (GitHub hasn't worked it out yet). */
  readonly mergeable: string
  readonly merge_state: string | null
  readonly review_decision: string | null
  readonly checks: ReadonlyArray<Check>
  readonly remarks: ReadonlyArray<Remark>
}

/** GitHub's errors in an answer, or `otherwise`. */
export const errorsOf = (v: unknown, otherwise: string): string => {
  const messages = arr(obj(v)["errors"]).flatMap((e) => {
    const m = str(obj(e)["message"])
    return m === null ? [] : [m]
  })
  return messages.length > 0 ? messages.join("; ") : otherwise
}

/** A pull request from the query's answer, or GitHub's errors if it has none. */
export const parsePr = (v: unknown): Result.Result<Pr, string> => {
  const pr = objOrNull(at(v, "data", "repository", "pullRequest"))
  if (pr === null) return Result.fail(errorsOf(v, "GitHub didn't return the pull request"))
  const remarks: Array<Remark> = []
  const remark = (n: JsonObject, kind: Remark["kind"], fields: Partial<Remark>): Remark => ({
    id: str(n["id"]) ?? "",
    author: str(at(n, "author", "login")),
    bot: at(n, "author", "__typename") === "Bot",
    association: lower(n["authorAssociation"]),
    kind,
    review_state: null,
    path: null,
    line: null,
    body: str(n["body"]) ?? "",
    url: str(n["url"]),
    at: str(n["createdAt"]),
    ...fields,
  })
  for (const n of nodes(pr["comments"])) remarks.push(remark(obj(n), "comment", {}))
  for (const node of nodes(pr["reviews"])) {
    const n = obj(node)
    // A review being written is its author's own.
    if (n["state"] === "PENDING") continue
    remarks.push(remark(n, "review", { review_state: lower(n["state"]), at: str(n["submittedAt"]) }))
  }
  for (const thread of nodes(pr["reviewThreads"])) {
    const t = obj(thread)
    for (const node of nodes(t["comments"])) {
      const n = obj(node)
      remarks.push(remark(n, "review_comment", { path: str(n["path"]) ?? str(t["path"]), line: u64(n["line"]) ?? u64(n["originalLine"]) }))
    }
  }
  const kept = remarks.filter((r) => r.id !== "")
  kept.sort((a, b) => (a.at === b.at ? 0 : a.at === null ? -1 : b.at === null ? 1 : a.at < b.at ? -1 : 1))
  return Result.succeed({
    viewer: str(at(v, "data", "viewer", "login")) ?? "",
    url: str(pr["url"]) ?? "",
    number: u64(pr["number"]) ?? 0,
    title: str(pr["title"]) ?? "",
    state: lower(pr["state"]) ?? "open",
    draft: pr["isDraft"] === true,
    base: str(pr["baseRefName"]) ?? "",
    head: str(pr["headRefOid"]) ?? "",
    mergeable: lower(pr["mergeable"]) ?? "unknown",
    merge_state: lower(pr["mergeStateStatus"]),
    review_decision: lower(pr["reviewDecision"]),
    checks: checksOf(pr),
    remarks: kept,
  })
}

/** The cursor of the next page of an answer's review threads, if it has one. */
export const nextThreads = (v: unknown): string | null => {
  const info = obj(at(v, "data", "repository", "pullRequest", "reviewThreads", "pageInfo"))
  return info["hasNextPage"] === true ? str(info["endCursor"]) : null
}

/**
 * An answer with the review threads of `page` (a `THREADS` answer) added to its own, or why the page has none. The
 * answers are plain JSON, made again here rather than changed.
 */
export const withThreads = (v: unknown, page: unknown): Result.Result<unknown, string> => {
  const more = obj(at(page, "data", "repository", "pullRequest", "reviewThreads"))
  if (!isArray(more["nodes"])) {
    const parsed = parsePr(page)
    return Result.fail(Result.isFailure(parsed) ? parsed.failure : "GitHub didn't return the pull request's review threads")
  }
  const data = obj(obj(v)["data"])
  const repository = obj(data["repository"])
  const pr = obj(repository["pullRequest"])
  const threads = obj(pr["reviewThreads"])
  const merged = { ...threads, nodes: [...arr(threads["nodes"]), ...more["nodes"]], pageInfo: more["pageInfo"] ?? null }
  return Result.succeed({ ...obj(v), data: { ...data, repository: { ...repository, pullRequest: { ...pr, reviewThreads: merged } } } })
}

// ---- what the agent has been told --------------------------------------------------------------------------------

/** What the agent has been told about a pull request. */
export const Seen = Schema.Struct({
  /** The head commit whose checks it was told about. */
  head: Schema.NullOr(Schema.String),
  /** That commit's failed checks it was told of (see `Check.key`). */
  failed: Schema.Array(Schema.String),
  /** Whether it was told that commit's checks passed. */
  passed: Schema.Boolean,
  /** The comments and reviews it has seen (ids), the latest last. */
  remarks: Schema.Array(Schema.String),
  /** Whether it was told the pull request conflicts with its base (and it still does). */
  conflicting: Schema.Boolean,
})
export type Seen = typeof Seen.Type

export const seenNothing: Seen = { head: null, failed: [], passed: false, remarks: [], conflicting: false }

// ---- news ---------------------------------------------------------------------------------------------------------

const FailedCheckNews = Schema.Struct({ conclusion: Schema.String, name: Schema.String, required: Schema.Boolean, url: Schema.NullOr(Schema.String) })

/** The pull request's state, for the agent (`summary`); what the last read found. */
export const PrSummary = Schema.Struct({
  base_branch: Schema.String,
  checks: Schema.Struct({
    failed: Schema.Array(FailedCheckNews),
    outcome: Schema.Literals(["failed", "passed", "pending", "none"]),
    passed: Schema.Int,
    pending: Schema.Array(Schema.String),
    required_checks: Schema.Boolean,
  }),
  draft: Schema.Boolean,
  head: Schema.String,
  merge_state: Schema.NullOr(Schema.String),
  mergeable: Schema.String,
  number: Schema.Int,
  review_decision: Schema.NullOr(Schema.String),
  state: Schema.String,
  title: Schema.String,
  url: Schema.String,
})
export type PrSummary = typeof PrSummary.Type

const CommentNews = Schema.Struct({
  at: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  kind: Schema.String,
  url: Schema.NullOr(Schema.String),
  author_association: Schema.optionalKey(Schema.String),
  review_state: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.NullOr(Schema.Int)),
})

/**
 * News about a pull request, as a wait returns it in `pull_request`: its state (`PrSummary`) with what happened
 * (`events`) and the new comments; or, for one that couldn't be read, `error` with its number and URL.
 */
export const News = Schema.Struct({
  base_branch: Schema.optionalKey(PrSummary.fields.base_branch),
  checks: Schema.optionalKey(PrSummary.fields.checks),
  draft: Schema.optionalKey(PrSummary.fields.draft),
  head: Schema.optionalKey(PrSummary.fields.head),
  merge_state: Schema.optionalKey(PrSummary.fields.merge_state),
  mergeable: Schema.optionalKey(PrSummary.fields.mergeable),
  number: Schema.optionalKey(PrSummary.fields.number),
  review_decision: Schema.optionalKey(PrSummary.fields.review_decision),
  state: Schema.optionalKey(PrSummary.fields.state),
  title: Schema.optionalKey(PrSummary.fields.title),
  url: Schema.optionalKey(PrSummary.fields.url),
  error: Schema.optionalKey(Schema.String),
  events: Schema.Array(Schema.String),
  comments: Schema.optionalKey(Schema.Array(CommentNews)),
  more_comments: Schema.optionalKey(Schema.Int),
})
export type News = Schema.Schema.Type<typeof News>

const decodeNews = Schema.decodeUnknownOption(News)

/** A stored wait's news, as it was written; null for anything else. */
export const newsOf = (v: unknown): News | null => Option.getOrNull(decodeNews(v))

/** What the tool tells the agent about `news` (a stored wait's) on its pull request. */
export const note = (news: unknown): string => {
  const n = newsOf(news)
  return n === null ? "There's news about your pull request (see pull_request)." : prNote(n)
}

/** The pull request's state, for the agent. */
export const summary = (pr: Pr): PrSummary => ({
  base_branch: pr.base,
  checks: {
    failed: failedNews(pr.checks),
    outcome: outcome(pr.checks),
    passed: pr.checks.filter((c) => c.state === "Passed").length,
    pending: pr.checks.filter((c) => c.state === "Pending").map((c) => c.name),
    required_checks: pr.checks.some((c) => c.required),
  },
  draft: pr.draft,
  head: pr.head,
  merge_state: pr.merge_state,
  mergeable: pr.mergeable,
  number: pr.number,
  review_decision: pr.review_decision,
  state: pr.state,
  title: pr.title,
  url: pr.url,
})

/** The failed checks, as the news lists them. */
export const failedNews = (checks: ReadonlyArray<Check>): Array<NewsFailed> =>
  checks.filter((c) => c.state === "Failed").map((c) => ({ conclusion: c.conclusion, name: c.name, required: c.required, url: c.url }))

/** A comment's text without HTML comments (bots' metadata), and cut short if it's long. */
export const trimmed = (body: string): string => {
  let text = ""
  let rest = body
  for (;;) {
    const i = rest.indexOf("<!--")
    if (i < 0) break
    text += rest.slice(0, i)
    const j = rest.indexOf("-->", i)
    rest = j < 0 ? "" : rest.slice(j + 3)
  }
  text += rest
  const chars = Array.from(text.trim())
  if (chars.length > BODY_MAX) return `${chars.slice(0, BODY_MAX).join("")}… [${chars.length - BODY_MAX} more characters]`
  return chars.join("")
}

/** A comment for the agent, its text trimmed. */
const remarkNews = (r: Remark): NewsComment => ({
  at: r.at,
  author: r.author,
  body: trimmed(r.body),
  kind: r.kind,
  url: r.url,
  ...(r.association === null ? {} : { author_association: r.association }),
  ...(r.review_state === null ? {} : { review_state: r.review_state }),
  ...(r.path === null ? {} : { path: r.path, line: r.line }),
})

const isOwn = (pr: Pr, r: Remark): boolean => r.author !== null && pr.viewer !== "" && r.author.toLowerCase() === pr.viewer.toLowerCase()

/** What `compare` found: what to keep as seen now, and the news with what the agent will have been told once it gets it. */
export interface Compared {
  readonly quiet: Seen
  readonly news: { readonly news: News; readonly told: Seen } | null
}

/**
 * What's news in `pr` to an agent that was told `seen` (null for its first wait on it), of `events`: what to store as
 * seen meanwhile (its own comments, a conflict that's gone), and the news, if any, with what it will have been told once
 * it gets it. `waiting` for a `wait`, which a conflict also ends when it wants checks and none is running (see below).
 */
export const compare = (seen: Seen | null, pr: Pr, events: ReadonlyArray<string>, waiting = false): Compared => {
  const wants = (e: string) => events.includes(e)
  const first = seen === null
  const quietRemarks = [...(seen ?? seenNothing).remarks]
  // Never news: the agent's own comments, those from before its first wait, and reviews that only say their comments
  // were made.
  for (const r of pr.remarks) {
    if ((first || isOwn(pr, r) || isBareReview(r)) && !quietRemarks.includes(r.id)) quietRemarks.push(r.id)
  }
  // Unknown while GitHub works it out (after a push): only a clean answer ends a conflict.
  const conflicting = pr.mergeable === "conflicting" ? true : pr.mergeable === "mergeable" ? false : null
  // Over SEEN_MAX, the oldest ids that this read doesn't see go: one it sees would be news again.
  const visible = new Set(pr.remarks.map((r) => r.id))
  const trim = (remarks: ReadonlyArray<string>): Array<string> => {
    let extra = Math.max(0, remarks.length - SEEN_MAX)
    return remarks.filter((id) => {
      const drop = extra > 0 && !visible.has(id)
      if (drop) extra--
      return !drop
    })
  }
  const base = seen ?? seenNothing
  const quiet: Seen = { ...base, remarks: trim(quietRemarks), conflicting: conflicting === false ? false : base.conflicting }

  let told: Seen = quiet
  const found: Array<string> = []
  // The head's checks: what the agent was told of them, if it's the head it was told about.
  const sameHead = quiet.head === pr.head
  const failed = sameHead ? [...quiet.failed] : []
  let wasPassed = sameHead ? quiet.passed : false
  const newFailed = pr.checks.filter((c) => c.state === "Failed" && !failed.includes(c.key))
  let checksNews = false
  if (wants("checks_failed") && newFailed.length > 0) {
    found.push("checks_failed")
    failed.push(...newFailed.map((c) => c.key))
    checksNews = true
  }
  if (wants("checks_passed") && passed(pr.checks) && !wasPassed) {
    found.push("checks_passed")
    wasPassed = true
    checksNews = true
  }
  if (checksNews) told = { ...told, head: pr.head, failed, passed: wasPassed }
  const newRemarks = pr.remarks.filter((r) => !quiet.remarks.includes(r.id))
  if (wants("comments") && newRemarks.length > 0) {
    found.push("comments")
    told = { ...told, remarks: trim([...told.remarks, ...newRemarks.map((r) => r.id)]) }
  }
  if (wants("conflicts") && conflicting === true && !quiet.conflicting) {
    found.push("conflicts")
    told = { ...told, conflicting: true }
  } else if (
    waiting &&
    (wants("checks_failed") || wants("checks_passed")) &&
    conflicting === true &&
    found.length === 0 &&
    !pr.checks.some((c) => c.state === "Pending")
  ) {
    // GitHub doesn't run `pull_request` workflows on a pull request that conflicts with its base, so a wait on checks
    // with none of them running would never end (HA-287). Said to each such wait, even one that was told of it before,
    // and not counted as told, so a wait that wants conflicts still hears of it. Not for the in-review watcher, which
    // would wake the agent with it on every read.
    found.push("conflicts")
  }
  if (pr.state === "merged" || pr.state === "closed") found.push(pr.state)
  if (found.length === 0) return { quiet, news: null }
  const comments = found.includes("comments")
    ? {
        comments: newRemarks.slice(0, LISTED).map(remarkNews),
        ...(newRemarks.length > LISTED ? { more_comments: newRemarks.length - LISTED } : {}),
      }
    : {}
  const news: News = { ...summary(pr), events: found, ...comments }
  return { quiet, news: { news, told } }
}

/** The news for a wait whose pull request couldn't be read `times` times in a row. */
export const unreadable = (label: string, number: number, url: string, times: number, error: string): News => ({
  error: `${label} couldn't be read ${times} times in a row: ${error}`,
  events: ["unreadable"],
  number,
  url,
})
