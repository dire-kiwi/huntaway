import type { Task, WatchPullRequests } from "@huntaway/contracts"
import { byMaintainer, compare, summary } from "./pr.ts"
import type { News, Pr } from "./pr.ts"
import { emptyRow } from "./seen.ts"
import type { WatchRow } from "./seen.ts"

// What the in-review watcher decides (huntaway's mcp/pr_watch/in_review.ts): which news wakes an agent whose task waits
// in In review, when its agent counts as idle, and what a read of its pull request does to the record of what it has
// been told. Plain functions; the loop is `review/InReview`.

/**
 * How many times in a row news of comments alone wakes an agent. After that, comments wait (and go with the next news
 * of checks or a conflict) until the user writes to the agent, so a bot or a reply loop can't keep it working.
 */
export const COMMENT_WAKES = 10

/** The news that wakes an agent in a project that watches its pull requests `mode`. */
export const wakeEvents = (mode: WatchPullRequests): ReadonlyArray<string> => {
  if (mode === "all") return ["checks_failed", "conflicts", "comments"]
  if (mode === "failures") return ["checks_failed", "conflicts"]
  return []
}

/**
 * Whether `t`'s agent is idle, so that news would wake it: it has a conversation, and isn't working, waiting or
 * merging, with no message from the user waiting for it and no review in progress.
 */
export const idle = (t: Task): boolean =>
  t.session_id !== null &&
  !t.running &&
  !t.waiting &&
  !t.merging &&
  t.agent_wait === null &&
  t.steering.length === 0 &&
  (t.queued_message ?? "").trim() === "" &&
  t.review?.state !== "running"

/** News to wake an agent with, kept as `call`'s until it's sent. */
export interface Wake {
  readonly news: News
  readonly call: string
  readonly commentsOnly: boolean
}

/** What a read of a task in review's pull request does: the row to store, the wake (if any), and whether comments just paused. */
export interface WakeDecision {
  readonly row: WatchRow
  readonly wake: Wake | null
  /** Comments stopped waking the agent with this read: the thread says so. */
  readonly paused: boolean
}

/**
 * What's news in `read` to wake the agent with, in a project that watches pull requests `mode`, given what it was told
 * (`row`, null for the first read). What isn't news is stored as seen now, as for a wait. `userWrote`: the user wrote to
 * the agent since comments last woke it, which lets them wake it again. `call` names the news kept until it's sent.
 */
export const decideWake = (row: WatchRow | null, read: Pr, mode: WatchPullRequests, userWrote: boolean, call: string, now: string): WakeDecision => {
  const first = row === null
  const base = row ?? emptyRow
  // Only people who can push to the repository wake the agent: on a public repository anyone can comment, and a wake
  // starts the agent's turn with no one watching. Others' comments, and bots', stay news for a wait (which the agent
  // chose to make). A first read counts them as seen with the rest.
  const pr: Pr = first ? read : { ...read, remarks: read.remarks.filter((r) => !r.bot && byMaintainer(r)) }
  const found = compare(first ? null : base.seen, pr, wakeEvents(mode))
  // The user writing to the agent lets comments wake it again.
  const reset = base.comment_wakes > 0 && base.woke_at !== undefined && userWrote
  let next: WatchRow = {
    ...base,
    seen: found.quiet,
    last: summary(pr),
    polled_at: now,
    ...(reset ? { comment_wakes: 0, comments_paused: false } : {}),
  }
  // Being merged or closed isn't for the agent to deal with.
  const news = pr.state === "open" ? found.news : null
  if (news === null) return { row: next, wake: null, paused: false }
  const commentsOnly = news.news.events.length === 1 && news.news.events[0] === "comments"
  if (commentsOnly && next.comment_wakes >= COMMENT_WAKES) {
    // They stay news, for the next wake or a wait.
    const paused = !next.comments_paused
    return { row: { ...next, comments_paused: true }, wake: null, paused }
  }
  next = { ...next, pending: { call_id: call, told: news.told } }
  return { row: next, wake: { news: news.news, call, commentsOnly }, paused: false }
}

/** The row once a wake was sent: its news told, and comment-only wakes counted (any other wake starts the count again). */
export const woke = (row: WatchRow, commentsOnly: boolean, at: string): WatchRow => ({
  ...row,
  ...(commentsOnly ? { comment_wakes: row.comment_wakes + 1 } : { comment_wakes: 0, comments_paused: false }),
  woke_at: at,
})
