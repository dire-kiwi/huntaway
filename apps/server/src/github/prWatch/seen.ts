import { Schema } from "effect"
import { PrSummary, Seen, seenNothing } from "./pr.ts"

// What an agent has been told about each of its task's pull requests (huntaway's mcp/pr_watch/seen.ts): a
// `pr_watches` row's `state`, kept across its waits, the in-review watcher's wakes and server restarts.

/** What a call found and hasn't returned yet: what the agent will have been told once it has. */
export const Pending = Schema.Struct({
  call_id: Schema.String,
  told: Seen,
  /**
   * The failures in an in-review wake's news were sent by hand (Fix broken checks) before the wake was: it isn't sent
   * then, and the next read works out what's still news. Left out when false.
   */
  superseded: Schema.optionalKey(Schema.Boolean),
})
export type Pending = typeof Pending.Type

/** A `pr_watches` row's state. */
export const WatchRow = Schema.Struct({
  seen: Seen,
  pending: Schema.optionalKey(Pending),
  /** What the last read found (see `summary`), and when. */
  last: Schema.NullOr(PrSummary),
  polled_at: Schema.String,
  /**
   * How many times in a row news of comments alone woke the agent while its task was in review, when it last woke it,
   * and whether comments stopped waking it after `COMMENT_WAKES` of those.
   */
  comment_wakes: Schema.Int,
  woke_at: Schema.optionalKey(Schema.String),
  comments_paused: Schema.Boolean,
})
export type WatchRow = typeof WatchRow.Type

export const emptyRow: WatchRow = { seen: seenNothing, last: null, polled_at: "", comment_wakes: 0, comments_paused: false }

/** `row` without its pending news. */
export const withoutPending = (row: WatchRow): WatchRow => {
  const { pending: _pending, ...rest } = row
  return rest
}

/**
 * The news that `call` found has reached the agent, if it's still the news kept for it: it's been told, and `also`
 * changes the row with it. Null when there's nothing to change.
 */
export const toldOf = (row: WatchRow, call: string, also: (row: WatchRow) => WatchRow = (r) => r): WatchRow | null => {
  const p = row.pending
  if (p === undefined || p.call_id !== call) return null
  return also({ ...withoutPending(row), seen: p.told })
}
