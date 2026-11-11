import { Schema } from "effect"
import { type Delta, type SavedEvent, ThreadEvent, type UnknownEvent } from "./Event.ts"
import type { Item } from "./Item.ts"
import type { ThreadRequest } from "./Request.ts"
import { type Preview, type Snapshot, type ThreadMessage, ThreadPreview, ThreadSnapshot } from "./Snapshot.ts"
import type { Thread } from "./Thread.ts"

// The reducer the server and the clients fold a thread's events with. It never changes the state it is given. What an
// event leaves as it was keeps its identity: an event about one item makes a new items array holding a new object for
// that item, and every other item is the same object, so a row showing it need not redraw. An event that changes
// nothing returns the state itself.

/** What the reducer takes: an event of this build's types, or one of a newer host's (counted, otherwise ignored). */
export type AnyThreadEvent = ThreadEvent | UnknownEvent

/** Whether an event is one this build knows, whole: one that is not (a newer type, or a known type with a newer item) is only counted. */
const isKnown = Schema.is(ThreadEvent)
const isPreview = Schema.is(ThreadPreview)
const isSnapshot = Schema.is(ThreadSnapshot)

/** A thread's state before any of its events. */
export const initialState = (thread: Thread): Snapshot => ({ thread, items: [], requests: [], seq: 0 })

/**
 * The state after `event`. Events for another thread, and saved events the state already has (seq at or below
 * `state.seq`, e.g. replayed after a reconnect), change nothing.
 */
export const applyEvent = (state: Snapshot, event: AnyThreadEvent): Snapshot => {
  if (event.thread_id !== state.thread.id) return state
  // A newer host's event type: there is nothing to do with it but count it.
  if (!isKnown(event)) return event.seq <= state.seq ? state : { ...state, seq: event.seq }
  if (event.type === "delta") return applyDelta(state, event)
  if (event.seq <= state.seq) return state
  return { ...applySaved(state, event), seq: event.seq }
}

/** The state after each of `events` in turn. */
export const applyEvents = (state: Snapshot, events: Iterable<AnyThreadEvent>): Snapshot => {
  let next = state
  for (const event of events) next = applyEvent(next, event)
  return next
}

/** The requests that are open: those not resolved yet. */
export const openRequests = (state: Pick<Snapshot, "requests">): ReadonlyArray<ThreadRequest> => state.requests.filter((r) => r.resolution === undefined)

/**
 * Whether `event` shows that saved events before it were missed: it is saved, and its seq is more than one past the
 * state's. A client that sees one takes a fresh window rather than apply it.
 */
export const isGap = (state: Snapshot, event: AnyThreadEvent): boolean =>
  event.type !== "delta" && event.thread_id === state.thread.id && event.seq > state.seq + 1

/** The item with `patch`'s fields set, and those set to null removed (`id` and `type` stay); the item itself if that changes nothing. */
export const patched = <T extends Item>(item: T, patch: Readonly<Record<string, unknown>>): T => {
  const changes = Object.entries(patch).filter(([k, v]) => k !== "id" && k !== "type" && (v === null ? k in item : Reflect.get(item, k) !== v))
  if (changes.length === 0) return item
  const next = { ...item }
  for (const [k, v] of changes) {
    if (v === null) Reflect.deleteProperty(next, k)
    else Reflect.set(next, k, v)
  }
  return next
}

/**
 * The preview after `message`: a snapshot's own; a preview's text put at its offset (what the preview has from there
 * already is skipped, and a thread opened mid-reply shows the rest as it comes); a new reply for a preview with another
 * id; none once an item is added to the main conversation (the reply was saved, or the conversation moved on).
 */
export const previewAfter = (preview: Preview | null, message: ThreadMessage): Preview | null => {
  if (message.type === "snapshot" && isSnapshot(message)) return message.preview
  if (message.type === "preview" && isPreview(message)) {
    if (message.text === "") return preview
    const current = preview !== null && preview.item_id === message.item_id ? preview : { item_id: message.item_id, text: "" }
    const have = current.text.length - message.offset
    if (have >= message.text.length) return current
    return { item_id: current.item_id, text: current.text + (have > 0 ? message.text.slice(have) : message.text) }
  }
  if (isKnown(message) && message.type === "item.added" && message.item.parent_id === undefined) return null
  return preview
}

/**
 * A delta from before the last saved event the state has is already in it. Its text goes at `offset`: what the item
 * already has from there (a snapshot taken after the delta was sent) is skipped, and the rest appended. An offset past
 * the end of the text means deltas were missed: it is skipped, and the item's final text puts it right.
 */
const applyDelta = (state: Snapshot, event: Delta): Snapshot => {
  if (event.seq < state.seq || event.text === "") return state
  return withItem(state, event.item_id, (item) => {
    if (item.type !== "assistant_message" && item.type !== "reasoning") return item
    if ((item.type === "assistant_message") !== (event.kind === "text")) return item
    const have = item.text.length - event.offset
    if (have < 0 || have >= event.text.length) return item
    return { ...item, text: item.text + event.text.slice(have) }
  })
}

const applySaved = (state: Snapshot, event: SavedEvent): Snapshot => {
  if (event.type === "item.added") {
    const at = indexOf(state.items, event.item.id)
    return { ...state, items: at < 0 ? [...state.items, event.item] : replace(state.items, at, event.item) }
  }
  if (event.type === "item.updated") return withItem(state, event.item_id, (item) => patched(item, event.patch))
  if (event.type === "request.opened") {
    const at = indexOf(state.requests, event.request.id)
    return { ...state, requests: at < 0 ? [...state.requests, event.request] : replace(state.requests, at, event.request) }
  }
  const at = indexOf(state.requests, event.request_id)
  const request = state.requests[at]
  if (request === undefined) return state
  return { ...state, requests: replace(state.requests, at, { ...request, resolution: event.resolution }) }
}

/** The state with item `id` changed by `change`; the state itself if there is none, or `change` returns it as it was. */
const withItem = (state: Snapshot, id: string, change: (item: Item) => Item): Snapshot => {
  const at = indexOf(state.items, id)
  const item = state.items[at]
  if (item === undefined) return state
  const next = change(item)
  return next === item ? state : { ...state, items: replace(state.items, at, next) }
}

/** Updates are nearly always to recent items and requests, so it looks from the end. -1 if there is none. */
const indexOf = (list: ReadonlyArray<{ readonly id: string }>, id: string): number => list.findLastIndex((x) => x.id === id)

const replace = <T>(list: ReadonlyArray<T>, at: number, value: T): ReadonlyArray<T> => list.with(at, value)
