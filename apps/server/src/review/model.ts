import { Cause, Option, Result, Schema } from "effect"
import type { ChangeSummary, Profile, Project, Review, Reviewer, ReviewerRun, Task, TaskId, Timestamp } from "@huntaway/contracts"
import { reviewFound, reviewIssues } from "../prompts/reviewFixes.ts"
import { outcomeOf } from "../runs/finish.ts"
import type { Outcome, Run } from "../runs/Run.ts"

// The rules of automatic review and summaries (docs/plan/inventory/04-git-review.md 2.12, 2.13, 2.19; huntaway's
// review.ts, review/summary.ts and db/review_stats.ts), as plain functions of the rows `Reviews` and `Summaries` read:
// who reviews, a reviewer's part ending, combining the parts, what `submit_review` records, what a finished review does
// with its issues, stopping, extending, and the summaries' threads.

/**
 * A review or summary that can't start, or a call about one refused: `conflict` (the old 409, "Can't review: …"), or
 * `invalid` (the old 400: the worktree's HEAD can't be read, a submission from a thread that isn't a reviewer's).
 */
export class ReviewRefused extends Schema.TaggedError<ReviewRefused, { readonly brand: unique symbol }>()("ReviewRefused", {
  reason: Schema.String,
  invalid: Schema.Boolean,
}) {
  static readonly conflict = (reason: string) => new ReviewRefused({ reason, invalid: false })
  static readonly invalid = (reason: string) => new ReviewRefused({ reason, invalid: true })
}

/** Most reviewers a project can have. */
export const MAX_REVIEWERS = 6

/** The task type of a summary thread. */
export const SUMMARY = "summary"

/** One reviewer (or summarizer) with the task's config and the defaults. */
export const DEFAULT_REVIEWER: Reviewer = { claude_config_id: null, model: null, effort: null }

/** A non-blank string, else null. */
export const nonBlank = (s: string | null | undefined): string | null => (s != null && s.trim() !== "" ? s : null)

/** Two optional strings as the old code compared them (a missing one is null). */
export const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null)

/** Rust's `str::lines`: split on `\n` (dropping a `\r` before it), without a last empty line. */
const lines = (s: string): Array<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

/** The first line of `s`. */
export const firstLine = (s: string): string => lines(s)[0] ?? ""

/** What a failure says, as the old `err_str` gave it: a refusal's detail or reason, else the first line of the cause. */
export const failureText = (cause: Cause.Cause<unknown>): string => {
  const found = Cause.findErrorOption(cause)
  if (Option.isSome(found)) {
    const e: unknown = found.value
    if (typeof e === "object" && e !== null) {
      if ("detail" in e && typeof e.detail === "string") return e.detail
      if ("reason" in e && typeof e.reason === "string") return e.reason
      if ("message" in e && typeof e.message === "string" && e.message !== "") return e.message
    }
  }
  return firstLine(Cause.pretty(cause)) || "it failed"
}

/**
 * How a run whose end the reactor never handled ended (Recovery: the server stopped in between), from its row: a stop
 * cancelled it, a failed last turn failed it, a turn ended is fine, else it failed.
 */
export const recoveredOutcome = (run: Run): Outcome =>
  outcomeOf(run, { code: run.saw_result ? 0 : null, signal: null, error: "the server stopped before the run's end was handled" }, "")

/** How a reviewer reads on the board: its config, model and effort ("Claude" with no config). */
export const label = (configName: string | null, model: string | null, effort: string | null): string =>
  [configName ?? "Claude", model, effort].filter((x) => x !== null).join(" · ")

/** Who reviews `project`'s tasks: its own reviewers, else its profile's, else one with the task's config. */
export const reviewersFor = (project: Pick<Project, "reviewers">, profile: Pick<Profile, "reviewers"> | null): ReadonlyArray<Reviewer> =>
  project.reviewers.length > 0 ? project.reviewers : profile !== null && profile.reviewers.length > 0 ? profile.reviewers : [DEFAULT_REVIEWER]

/** Who summarises `project`'s tasks: its own summarizers, else its profile's, else one with the task's config. */
export const summarizersFor = (project: Pick<Project, "summarizers">, profile: Pick<Profile, "summarizers"> | null): ReadonlyArray<Reviewer> =>
  project.summarizers.length > 0 ? project.summarizers : profile !== null && profile.summarizers.length > 0 ? profile.summarizers : [DEFAULT_REVIEWER]

/** Whether `thread` is a summary thread. */
export const isSummary = (thread: Pick<Task, "kind" | "task_type">): boolean => thread.kind === "review" && thread.task_type === SUMMARY

/** Whether `thread` is one of its task's reviewers' threads (not a summary's or a workflow step's). */
export const isReviewer = (thread: Pick<Task, "kind" | "task_type">): boolean => thread.kind === "review" && thread.task_type === null

// ---- a review's parts -------------------------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** A review with each reviewer's part: one from before there could be several has just its one, from its own fields. */
export const withParts = (r: Review): Review => {
  if (r.reviewers.length > 0 || r.thread_id === "") return r
  const part: Mutable<ReviewerRun> = { thread_id: r.thread_id, label: "", state: r.state, summary: r.summary, issues: [...r.issues] }
  if (r.verdict !== undefined) part.verdict = r.verdict
  const { verdict: _verdict, ...rest } = r
  return { ...rest, reviewers: [part] }
}

/** The review if `thread`'s part in it is in progress (the review running, the part running). */
export const inProgress = (review: Review | null, thread: TaskId): Review | null => {
  if (review === null || review.state !== "running") return null
  const r = withParts(review)
  return r.reviewers.some((p) => p.thread_id === thread && p.state === "running") ? r : null
}

/**
 * The parts combined once none is running: the issues they all found (each with who found it, when there are
 * several), and `issues` if there are any, `passed` if they all passed, else `failed` (or `stopped` if they all were).
 * A pass resets the rounds of fixes, so the next review that finds issues starts a cycle of the project's rounds.
 */
export const combine = (r: Review): Review => {
  if (r.reviewers.some((p) => p.state === "running")) return Object.assign({}, r, { state: "running" as const })
  const several = r.reviewers.length > 1
  const issues = r.reviewers.flatMap((p) => p.issues.map((i) => (several ? `(${p.label}) ${i}` : i)))
  const all = (st: ReviewerRun["state"]) => r.reviewers.every((p) => p.state === st)
  const state = issues.length > 0 ? "issues" : all("passed") ? "passed" : all("stopped") ? "stopped" : "failed"
  let summary: string | null
  if (r.reviewers.length === 1) summary = r.reviewers[0]?.summary ?? null
  else {
    const each = r.reviewers.filter((p) => p.summary !== null).map((p) => `**${p.label}:** ${p.summary}`)
    summary = each.length > 0 ? each.join("\n\n") : null
  }
  const { verdict: _verdict, ...rest } = r
  return { ...rest, state, issues, summary, ...(state === "passed" ? { fixes: 0, extra_rounds: 0 } : {}) }
}

/**
 * `thread`'s part ended with `end` (which sets its state and summary): its verdict goes, its issues unless it found
 * some, and the review is combined. Null when the part isn't in progress.
 */
export const endPart = (
  review: Review | null,
  thread: TaskId,
  end: (p: ReviewerRun) => Pick<ReviewerRun, "state" | "summary">,
  at: Timestamp,
): Review | null => {
  const r = inProgress(review, thread)
  if (r === null) return null
  const reviewers = r.reviewers.map((p) => {
    if (p.thread_id !== thread) return p
    const ended = end(p)
    const { verdict: _verdict, ...rest } = p
    return { ...rest, state: ended.state, summary: ended.summary, issues: ended.state === "issues" ? p.issues : [] }
  })
  return Object.assign({}, combine(Object.assign({}, r, { reviewers })), { updated_at: at })
}

/** How a reviewer's run ended, as its part: stopped, failed, asked something, no verdict, passed or found issues. */
export const reviewerEnd =
  (outcome: Outcome, attention: string | null) =>
  (part: ReviewerRun): Pick<ReviewerRun, "state" | "summary"> => {
    if (outcome._tag === "Cancelled") return { state: "stopped", summary: "The review was stopped." }
    if (outcome._tag === "Failed") return { state: "failed", summary: `The review failed: ${firstLine(outcome.reason)}` }
    if (attention !== null) return { state: "failed", summary: `The reviewer asked: ${attention}` }
    if (part.verdict === undefined) return { state: "failed", summary: "The reviewer finished without submitting a verdict." }
    if (part.verdict === "pass") return { state: "passed", summary: part.summary }
    return { state: "issues", summary: part.summary }
  }

/** What `submit_review` was given, as the old tool took it (a lone string for a list is a list of one). */
export interface Submitted {
  readonly verdict: "pass" | "needs_fixes"
  readonly summary?: string | undefined
  readonly serious_issues: ReadonlyArray<string>
  readonly minor_issues?: ReadonlyArray<string> | undefined
}

const trimmed = (list: ReadonlyArray<string>) => list.map((i) => i.trim()).filter((i) => i !== "")

/** What a submission records on its part: its summary, its verdict and its serious issues; and the minor ones listed. */
export const submission = (args: Submitted) => {
  const summary = nonBlank(args.summary)?.trim() ?? null
  const issues = trimmed(args.serious_issues)
  // A reviewer that wants fixes but didn't list them separately described them in its summary.
  if (args.verdict === "needs_fixes" && issues.length === 0)
    issues.push(summary ?? "The reviewer asked for fixes without saying what they are; see the review thread.")
  const minor = args.minor_issues === undefined ? null : trimmed(args.minor_issues)
  return { summary, verdict: issues.length > 0 ? ("issues" as const) : ("pass" as const), issues, minor }
}

/** The review with `thread`'s submission recorded on its part. */
export const submitted = (review: Review, thread: TaskId, s: ReturnType<typeof submission>, at: Timestamp): Review =>
  Object.assign({}, review, {
    reviewers: review.reviewers.map((p) => (p.thread_id === thread ? Object.assign({}, p, { summary: s.summary, verdict: s.verdict, issues: s.issues }) : p)),
    updated_at: at,
  })

/** The review stopped, saying `why`: every part still running stopped with it. Null when none is running. */
export const stopReview = (review: Review | null, why: string, at: Timestamp): { readonly review: Review; readonly running: ReadonlyArray<TaskId> } | null => {
  if (review === null || review.state !== "running") return null
  const r = withParts(review)
  const running = r.reviewers.filter((p) => p.state === "running").map((p) => p.thread_id)
  const reviewers = r.reviewers.map((p) => {
    if (p.state !== "running") return p
    const { verdict: _verdict, ...rest } = p
    return { ...rest, state: "stopped" as const, summary: why }
  })
  const { verdict: _verdict, ...rest } = r
  return { review: { ...rest, reviewers, state: "stopped", issues: [], summary: why, updated_at: at }, running }
}

// ---- what a finished review does --------------------------------------------------------------------------------

/** How many serious issues a review found, e.g. "The 2 reviewers found 3 serious issues". */
export const found = (review: Review): string => reviewFound(review.issues.length, review.reviewers.length)

/** A review's serious issues as a numbered list. */
export const listed = (review: Review): string => reviewIssues(review.issues)

/** What a review that found issues does (the old `send_issues`). */
export type IssuesDecision =
  /** The user (or the agent) has moved on: the findings are left as an event. */
  | { readonly _tag: "MovedOn" }
  /** Out of rounds of fixes: left for the user, the task needing attention with `reason`. */
  | { readonly _tag: "OutOfRounds"; readonly reason: string }
  /** Another round of fixes: its issues go to the task's agent, the review with `fixes` counted. */
  | { readonly _tag: "SendFixes"; readonly review: Review }

/** Send the issues back if the task still waits in In review, idle, with rounds of fixes left. */
export const decideIssues = (task: Pick<Task, "status" | "running">, review: Review, rounds: number): IssuesDecision => {
  if (task.status !== "in_review" || task.running) return { _tag: "MovedOn" }
  if (review.fixes >= rounds + review.extra_rounds) {
    const what = found(review)
    const reason = review.fixes === 0 ? what : review.fixes === 1 ? `${what} after a round of fixes` : `${what} after ${review.fixes} rounds of fixes`
    return { _tag: "OutOfRounds", reason }
  }
  return { _tag: "SendFixes", review: Object.assign({}, review, { fixes: review.fixes + 1 }) }
}

/** Why a task's review can't be given more rounds of fixes (`extend`), or the review with them. */
export const decideExtend = (
  task: Pick<Task, "status" | "merging" | "review" | "running">,
  rounds: number,
): { readonly _tag: "Refused"; readonly reason: string } | { readonly _tag: "Extended"; readonly review: Review; readonly more: number } => {
  const previous = task.review
  if (previous === null || previous.state !== "issues" || previous.issues.length === 0) {
    return { _tag: "Refused", reason: "the task's latest review didn't find issues to fix" }
  }
  if (previous.fixes < rounds + previous.extra_rounds) return { _tag: "Refused", reason: "the task hasn't used up its rounds of fixes" }
  if (task.running) return { _tag: "Refused", reason: "the agent is working on the task; wait for it to finish or stop it" }
  if (task.status === "done" || task.merging) return { _tag: "Refused", reason: "the task is done or merging; move it to another column first" }
  const more = Math.max(rounds, 1)
  return { _tag: "Extended", review: { ...previous, extra_rounds: previous.extra_rounds + more, fixes: previous.fixes + 1 }, more }
}

// ---- statistics -------------------------------------------------------------------------------------------------

const MINOR = new Set(["minor", "nit", "nits", "nitpick", "nitpicks", "suggestion", "suggestions"])
const DENIAL = new Set(["no", "without", "nor", "any", "zero"])

/**
 * Whether a review's summary says it found minor issues: "minor", "nit" or "nitpick", or "suggestion", as words, unless
 * only to say there are none ("no minor issues"): a "no", "any" and the like a few words before it in the same clause.
 */
export const mentionsMinor = (summary: string): boolean =>
  summary
    .toLowerCase()
    .split(/[.,;:!?\n]/u)
    .some((clause) => {
      const words = clause.split(/[^\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u).filter((w) => w !== "")
      return words.some((w, i) => MINOR.has(w) && !words.slice(Math.max(0, i - 4), i).some((p) => DENIAL.has(p)))
    })

/** Whether a submission noted minor issues: it listed some, or its summary mentions them. */
export const minorNoted = (minor: number | null, summary: string | null): boolean =>
  (minor !== null && minor > 0) || (summary !== null && mentionsMinor(summary))

// ---- summaries --------------------------------------------------------------------------------------------------

const jsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))

/**
 * What, besides its agent, tells a summarizer's thread from another's: its name, skills and prompt as text (empty if
 * it has none), the keys sorted as serde_json wrote them.
 */
export const variantKey = (spec: Reviewer): string => {
  const name = spec.name?.trim() ?? ""
  const prompt = spec.prompt?.trim() ?? ""
  const skills = spec.skills ?? []
  if (name === "" && prompt === "" && skills.length === 0) return ""
  return Result.getOrElse(jsonText({ name, prompt, skills }), () => "")
}

/** How a summarizer's run ended, as its summary: stopped, failed, asked something, or what it wrote since it was asked. */
export const summaryEnd = (outcome: Outcome, attention: string | null, written: string | null): Pick<ChangeSummary, "state" | "text"> => {
  if (outcome._tag === "Cancelled") return { state: "stopped", text: "The summary was stopped." }
  if (outcome._tag === "Failed") return { state: "failed", text: `The summary failed: ${firstLine(outcome.reason)}` }
  if (attention !== null) return { state: "failed", text: `The summarizer asked: ${attention}` }
  const w = written?.trim() ?? ""
  return w !== "" ? { state: "done", text: w } : { state: "failed", text: "The summarizer finished without writing a summary." }
}

/** The summaries with those running stopped, saying `why`; null when none is. */
export const stopSummaries = (
  all: ReadonlyArray<ChangeSummary>,
  why: string,
  at: Timestamp,
): { readonly summaries: ReadonlyArray<ChangeSummary>; readonly running: ReadonlyArray<TaskId> } | null => {
  const running = all.filter((s) => s.state === "running").map((s) => s.thread_id)
  if (running.length === 0) return null
  return { summaries: all.map((s) => (s.state === "running" ? Object.assign({}, s, { state: "stopped" as const, text: why, updated_at: at }) : s)), running }
}
