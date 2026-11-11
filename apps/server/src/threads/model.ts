import { Schema } from "effect"
import type { Item, NewEvent, ThreadRequest, Timestamp } from "@huntaway/contracts"

// What the board keeps about a thread beside the protocol (docs/plan/04-database.md, Write numbers and Thread tables;
// inventory 08, sections 3.2 and 3.3): write numbers, item ids made from them, and what the board knows about an item
// that the item does not say. Server-only: none of it crosses the wire.

/**
 * A board-wide write number (`counters` row `thread_write`): every board-side write to a thread takes the next one in
 * its transaction. It is the `<n>` of `legacy:<n>[:<block>]` item ids and the `write_no` of the items and requests
 * the write adds, and orders writes across the whole board without a clock ("has the conversation moved on").
 */
export const WriteNo = Schema.Int.pipe(Schema.brand("WriteNo"))
export type WriteNo = typeof WriteNo.Type

/**
 * What the board knows about an item that the item does not say (`thread_items.meta`; inventory 08, 3.3). The readers
 * go on it, and a translator rebuilds its state from it.
 *
 * On a user message: `auto` (the board sent it itself), `from_agent` (other agents sent all of it, by
 * `send_to_task`), `user_text` (the user's own part of a mixed message), `start` (the board's task-start prompt),
 * `routine` (a routine's prompt), `review_round` (sent to fix a review round's issues). On a tool call: `call_id` (the
 * harness's id of a second call that reused one, whose item has a `legacy:` id), `session` (the harness session the
 * call was made in), `subagent_task` (Claude's task id or Codex's child thread id), `shown_tasks` (the background bash
 * tasks it started). On a turn result: `result_text` (the result's text or error) and `compact` (a compaction run's
 * end). On an assistant message: `from_result` (a turn result's text nobody said; not drawn).
 */
export const ItemMeta = Schema.Struct({
  auto: Schema.optionalKey(Schema.Boolean),
  from_agent: Schema.optionalKey(Schema.Boolean),
  user_text: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.Boolean),
  routine: Schema.optionalKey(Schema.Boolean),
  review_round: Schema.optionalKey(Schema.Finite),
  call_id: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
  subagent_task: Schema.optionalKey(Schema.String),
  shown_tasks: Schema.optionalKey(Schema.Array(Schema.String)),
  result_text: Schema.optionalKey(Schema.String),
  compact: Schema.optionalKey(Schema.Boolean),
  from_result: Schema.optionalKey(Schema.Boolean),
})
export type ItemMeta = typeof ItemMeta.Type

/** Items' metas by item id: each replaces what its item had. */
export type ItemMetas = ReadonlyMap<string, ItemMeta>

/** An item as the store keeps it: its place in the thread, the write that made it, and what the board knows of it. */
export interface Entry {
  /** Its order in the thread (an index, but for gaps an import may leave). */
  readonly pos: number
  readonly item: Item
  /** `{}` for none. */
  readonly meta: ItemMeta
  /** The write that made it; null for an item an agent's output made without one. */
  readonly write_no: WriteNo | null
  readonly created_at: Timestamp
}

/** A request as the store keeps it, with the write that opened it. */
export interface StoredRequest {
  readonly request: ThreadRequest
  readonly write_no: WriteNo | null
}

/** What an agent's output adds to a thread: its events, and the metas of the items they add or change. */
export interface AgentWrite {
  readonly events: ReadonlyArray<NewEvent>
  readonly metas?: ItemMetas | undefined
}

/** The id of the item a board write `n` made (`legacy:<n>`), or of block `block` of it (`legacy:<n>:<block>`). */
export const legacyId = (n: WriteNo, block?: number | "result"): string => (block === undefined ? `legacy:${n}` : `legacy:${n}:${block}`)

/** The write an item's id names (`legacy:<n>` or `legacy:<n>:<block>`); undefined for an id of another form. */
export const writeNoOf = (id: string): WriteNo | undefined => {
  const m = /^legacy:(\d+)(?::|$)/.exec(id)
  return m?.[1] === undefined ? undefined : WriteNo.make(Number(m[1]))
}
