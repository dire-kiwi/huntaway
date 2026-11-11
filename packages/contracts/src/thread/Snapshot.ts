import { Schema } from "effect"
import { TaskId } from "../ids.ts"
import { ThreadEvent, UnknownEvent } from "./Event.ts"
import { Item } from "./Item.ts"
import { ThreadRequest } from "./Request.ts"
import { Thread } from "./Thread.ts"

// A thread's state, whole or as a window of its last items, and what `threads.watch` streams
// (docs/plan/05-protocol.md, A thread).

/**
 * A thread's state as of `seq`: what applying its saved events in order to the empty state gives. A window (taken with
 * a limit) has only its last items, from index `start`, and the items from before it that they need, whose indices are
 * `context`: they are the first `context.length` of `items`. A whole thread has neither.
 */
export const Snapshot = Schema.Struct({
  thread: Thread,
  items: Schema.Array(Item),
  /** Oldest first: the open ones, and the resolved ones with their resolution (a window's: see `snapshotWindow`). */
  requests: Schema.Array(ThreadRequest),
  /** The seq of the last saved event it includes; 0 for none. */
  seq: Schema.Int,
  start: Schema.optionalKey(Schema.Int),
  context: Schema.optionalKey(Schema.Array(Schema.Int)),
})
export type Snapshot = typeof Snapshot.Type

/** The thread's items before an index (a window's start), a page at a time: `threads.page`. */
export const ItemPage = Schema.Struct({
  thread_id: TaskId,
  /** The items of `context`, then the thread's items from `start` up to the index asked for. */
  items: Schema.Array(Item),
  /** The requests anchored in its items (after the context ones). */
  requests: Schema.Array(ThreadRequest),
  /** 0: there is nothing before it. */
  start: Schema.Int,
  context: Schema.Array(Schema.Int),
  seq: Schema.Int,
})
export type ItemPage = typeof ItemPage.Type

/**
 * The reply the agent is writing, as streamed so far: not an item until it is saved. `item_id` is the server's own
 * (`stream:<boot>:<n>`), new for each message the agent writes, and never an item's.
 */
export const Preview = Schema.Struct({ item_id: Schema.String, text: Schema.String })
export type Preview = typeof Preview.Type

/**
 * Streamed text for the reply being written: `text` goes at `offset` (UTF-16 code units) of preview `item_id`'s text.
 * Not saved; `seq` is the last saved event's. A preview with another `item_id` starts a new reply; an item added to
 * the main conversation (the reply saved) ends it (`previewAfter`).
 */
export const ThreadPreview = Schema.Struct({
  type: Schema.Literal("preview"),
  thread_id: TaskId,
  seq: Schema.Int,
  item_id: Schema.String,
  offset: Schema.Int,
  text: Schema.String,
})
export type ThreadPreview = typeof ThreadPreview.Type

/**
 * The first message of `threads.watch` (when it does not replay from `since`): a window of the thread's last `limit`
 * items with the items they need from before them, every open request, the thread's `seq`, and the reply being written
 * so far. A task with no thread yet is an empty one.
 */
export const ThreadSnapshot = Schema.Struct({ type: Schema.Literal("snapshot"), ...Snapshot.fields, preview: Schema.NullOr(Preview) })
export type ThreadSnapshot = typeof ThreadSnapshot.Type

/** A message of `threads.watch`: a snapshot, then saved events, deltas, previews, and events of a newer host's types. */
export const ThreadMessage = Schema.Union([ThreadSnapshot, ThreadEvent, ThreadPreview, UnknownEvent])
export type ThreadMessage = typeof ThreadMessage.Type
