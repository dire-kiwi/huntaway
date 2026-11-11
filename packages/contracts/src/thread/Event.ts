import { Schema } from "effect"
import { TaskId } from "../ids.ts"
import { Item } from "./Item.ts"
import { RequestResolution, ThreadRequest } from "./Request.ts"

// Every change to a thread is a numbered event. Saved events are numbered 1, 2, 3… in their thread with no gaps (but
// for the one a clear leaves, so that a client from before it sees a gap); a delta is not saved and carries the seq of
// the last saved event before it. Left out of the old protocol, as never produced: `thread.updated`, `turn.started`,
// `turn.completed`, `items.removed` and `turn_id`. A stream decodes an event of a type it does not know as an
// `UnknownEvent`, which the reducer counts and otherwise ignores.

const eventBase = {
  /** The task's id. */
  thread_id: TaskId,
  seq: Schema.Int,
}

/** An item was added at the end, or replaces the one with its id in place. */
export const ItemAdded = Schema.Struct({ type: Schema.Literal("item.added"), ...eventBase, item: Item })
export type ItemAdded = typeof ItemAdded.Type

/** Each of the patch's fields replaces the item's, and one set to null is removed. `id` and `type` never change. */
export const ItemUpdated = Schema.Struct({
  type: Schema.Literal("item.updated"),
  ...eventBase,
  item_id: Schema.String,
  patch: Schema.Record(Schema.String, Schema.Unknown),
})
export type ItemUpdated = typeof ItemUpdated.Type

/** A request was opened, or replaces the one with its id in place (opened again, or its record changed). */
export const RequestOpened = Schema.Struct({ type: Schema.Literal("request.opened"), ...eventBase, request: ThreadRequest })
export type RequestOpened = typeof RequestOpened.Type

/** A request was answered or cancelled. It stays, with its resolution. */
export const RequestResolved = Schema.Struct({
  type: Schema.Literal("request.resolved"),
  ...eventBase,
  request_id: Schema.String,
  resolution: RequestResolution,
})
export type RequestResolved = typeof RequestResolved.Type

/**
 * Streamed text for an `assistant_message` (`text`) or `reasoning` item the thread has, which was `offset` long (UTF-16
 * code units) before it. Not saved. The board streams the reply being written as `preview` messages instead (see
 * `ThreadPreview`), since that reply is not an item until it is saved.
 */
export const Delta = Schema.Struct({
  type: Schema.Literal("delta"),
  ...eventBase,
  item_id: Schema.String,
  kind: Schema.Literals(["text", "reasoning"]),
  offset: Schema.Int,
  text: Schema.String,
})
export type Delta = typeof Delta.Type

export const ThreadEvent = Schema.Union([ItemAdded, ItemUpdated, RequestOpened, RequestResolved, Delta])
export type ThreadEvent = typeof ThreadEvent.Type

/** Every event but a delta is saved. */
export const SavedEvent = Schema.Union([ItemAdded, ItemUpdated, RequestOpened, RequestResolved])
export type SavedEvent = typeof SavedEvent.Type

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event before it is numbered: what the store is given to save. */
export type NewEvent = DistributiveOmit<SavedEvent, "seq" | "thread_id">

/** An event of a type this build does not know (a newer host's), as a stream decodes it: counted, otherwise ignored. */
export const UnknownEvent = Schema.Struct({ type: Schema.String, ...eventBase })
export type UnknownEvent = typeof UnknownEvent.Type
