import type { Item } from "./Item.ts"
import type { ThreadRequest } from "./Request.ts"
import type { ItemPage, Snapshot } from "./Snapshot.ts"

// Windows and pages. A thread can run to thousands of items, so a client starts from its last ones and loads earlier
// ones a page at a time. Items are only added at the end (an `item.added` for an id the thread has replaces it in
// place) and never removed, so windows and pages say where they are by index: the count of items before, not a
// stored position.

/**
 * The window of `state` with its last `limit` items, and what they need from before them: the subagent calls they and
 * the open requests belong to, the open requests' tool calls, and every subagent's call (one still running may go on
 * adding items to the window, and a client lists them all, as the Agents list does), with their own parents. Its
 * requests are the open ones and the resolved ones anchored in it or nowhere. Without a limit, or with one it is
 * within, it is the state itself. `state` must be whole (not a window).
 */
export const snapshotWindow = (state: Snapshot, limit?: number): Snapshot => {
  const items = state.items
  if (limit === undefined || items.length <= limit) return state
  const start = items.length - Math.max(0, Math.floor(limit))
  const at = indices(items)
  const need = new Set<string>()
  for (const item of items.slice(start)) need.add(item.parent_id ?? "")
  for (const r of state.requests) {
    if (r.resolution !== undefined) continue
    need.add(r.parent_id ?? "")
    need.add(r.tool_call_id ?? "")
  }
  for (const item of items.slice(0, start)) if (isSubagent(item)) need.add(item.id)
  const context = contextOf(items, at, need, start)
  return windowOf(
    state,
    [...pick((i) => items[i], context), ...items.slice(start)],
    state.requests.filter((r) => {
      if (r.resolution === undefined) return true
      const a = anchor(at, r)
      return a < 0 || a >= start
    }),
    start,
    context,
  )
}

/**
 * The page of `state`'s items before index `before` (a window's start), at most `limit` of them, with the subagent
 * calls they belong to from before them, and the requests anchored in them. `state` must be whole.
 */
export const itemPage = (state: Snapshot, before: number, limit: number): ItemPage => {
  const items = state.items
  const end = Math.max(0, Math.min(Math.floor(before), items.length))
  const start = Math.max(0, end - Math.max(0, Math.floor(limit)))
  const at = indices(items)
  const need = new Set<string>()
  for (const item of items.slice(start, end)) need.add(item.parent_id ?? "")
  const context = contextOf(items, at, need, start)
  return {
    thread_id: state.thread.id,
    items: [...pick((i) => items[i], context), ...items.slice(start, end)],
    requests: state.requests.filter((r) => {
      const a = anchor(at, r)
      return a >= start && a < end
    }),
    start,
    context,
    seq: state.seq,
  }
}

/**
 * `state` (a window) with `page`, the page before its start, put in front of its items: the context items of both in
 * order (the page's version of one they share), less those the page's own items have, then the page's items, then its
 * own. The page's requests go in front of its own, the page's version of one it has replacing it in place. A page for
 * another thread, or that does not end at its start, changes nothing.
 */
export const withPage = (state: Snapshot, page: ItemPage): Snapshot => {
  const before = state.start ?? 0
  const own = state.context ?? []
  const theirs = page.context
  const body = page.items.slice(theirs.length)
  if (page.thread_id !== state.thread.id || before === 0 || page.start + body.length !== before || page.start >= before) return state
  const fresh = new Set(body.map((i) => i.id))
  const ctx = new Map<number, Item>()
  const keep = (list: ReadonlyArray<Item>) => (index: number, i: number) => {
    const item = list[i]
    if (item !== undefined && index < page.start && !fresh.has(item.id)) ctx.set(index, item)
  }
  own.forEach(keep(state.items))
  theirs.forEach(keep(page.items))
  const context = [...ctx.keys()].toSorted((a, b) => a - b)
  const kept = state.items.slice(own.length).filter((i) => !fresh.has(i.id))
  const pageRequests = new Map(page.requests.map((r) => [r.id, r]))
  const requests = [...page.requests.filter((r) => !state.requests.some((s) => s.id === r.id)), ...state.requests.map((r) => pageRequests.get(r.id) ?? r)]
  return windowOf(state, [...pick((i) => ctx.get(i), context), ...body, ...kept], requests, page.start, context)
}

/** Where a request is in the thread's items: the index of its tool call; -1 if it has none (or the window lacks it). */
export const requestAnchor = (items: ReadonlyArray<Item>, request: ThreadRequest): number => anchor(indices(items), request)

/** A subagent's call (a tool call of kind subagent), running or not. */
export const isSubagent = (item: Item): boolean => item.type === "tool_call" && item.kind === "subagent"

/**
 * A subagent's call whose subagent has not finished: by its subagent's status where it has one (a background
 * subagent's call completes as soon as it has started it), or else by the call's.
 */
export const isRunningSubagent = (item: Item): boolean =>
  item.type === "tool_call" &&
  item.kind === "subagent" &&
  (item.subagent === undefined ? item.status === "pending" || item.status === "running" : item.subagent.status === "running")

/** `state` with these items and requests, from `start` with `context`; a whole thread (start 0) has neither. */
const windowOf = (
  state: Snapshot,
  items: ReadonlyArray<Item>,
  requests: ReadonlyArray<ThreadRequest>,
  start: number,
  context: ReadonlyArray<number>,
): Snapshot => ({
  thread: state.thread,
  items,
  requests,
  seq: state.seq,
  ...(start > 0 ? { start } : {}),
  ...(start > 0 && context.length > 0 ? { context } : {}),
})

const anchor = (at: ReadonlyMap<string, number>, r: ThreadRequest): number => (r.tool_call_id === undefined ? undefined : at.get(r.tool_call_id)) ?? -1

const indices = (items: ReadonlyArray<Item>): ReadonlyMap<string, number> => new Map(items.map((item, i) => [item.id, i]))

/** The items at `positions`, which are known to be there. */
const pick = (get: (index: number) => Item | undefined, positions: ReadonlyArray<number>): ReadonlyArray<Item> =>
  positions.flatMap((i) => {
    const item = get(i)
    return item === undefined ? [] : [item]
  })

/** The indices before `start` of the items with an id in `need`, and of their parents, however nested; ascending. */
const contextOf = (items: ReadonlyArray<Item>, at: ReadonlyMap<string, number>, need: ReadonlySet<string>, start: number): ReadonlyArray<number> => {
  const out = new Set<number>()
  const seen = new Set<string>()
  for (const first of need) {
    for (let id: string | undefined = first; id !== undefined && id !== "" && !seen.has(id);) {
      seen.add(id)
      const i = at.get(id)
      if (i === undefined) break
      if (i < start) out.add(i)
      id = items[i]?.parent_id
    }
  }
  return [...out].toSorted((a, b) => a - b)
}
