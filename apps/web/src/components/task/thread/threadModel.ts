// What a thread shows: the view's model, which itemModel.ts builds from the thread's items. A new snapshot rebuilds
// it, but the parts it leaves as they were (items, tool calls and results, subagents, a subagent's rows) stay the same
// objects, so the rows that show them don't redraw.

import type { Subagent } from "./subagentView"

/**
 * The agent's tool input and the board's own metadata, which the rows read as the old ones did (step 1,
 * docs/plan/09-frontend.md): they are `Schema.Unknown` on the wire by design, and step 2 gives the rows their types.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the rows read the tool input and metadata loosely until step 2
export type Any = any

export interface ToolResult {
  content: string
  isError: boolean
}

export type Call = { id: string; name: string; input: Any; result?: ToolResult | undefined }

export type Item =
  | { type: "user"; key: string; text: string; auto?: boolean | undefined; steered?: boolean | undefined }
  | { type: "event"; key: string; level: string; text: string; detail?: string | null | undefined }
  | { type: "permission"; key: string; data: Any }
  | { type: "question"; key: string; id: number; data: Any }
  | { type: "text"; key: string; text: string }
  | { type: "thinking"; key: string; text: string }
  | { type: "tools"; key: string; calls: Call[] }
  | { type: "result"; key: string; data: Any }
  | { type: "compact"; key: string; meta: Any; summary?: string | undefined; result?: Any }
  /** A routine's report, posted in the assistant's thread (API 110). */
  | { type: "report"; key: string; data: Any }

export interface ThreadModel {
  items: Item[]
  results: Map<string, ToolResult>
  subagents: Map<string, Subagent>
  /** tool_use_id → the subagent that made the call, for calls made inside a subagent. */
  callParent: Map<string, string>
  /**
   * The id of the latest message sent to the agent in the main conversation (by the user, the board or another
   * agent), or 0: a question or plan from before it has been moved past, and isn't answered any more.
   */
  lastSent: number
  /** Each subagent's own items, prompts included, by its call's id. */
  childItems: Map<string, Item[]>
}

/** `next`, with the items (and tool calls) that are the same as in `prev` swapped for those in `prev`. */
export function reuseItems(next: Item[], prev: Item[]): Item[] {
  if (!prev.length) return next
  const old = new Map(prev.map((it) => [it.key, it]))
  let same = next.length === prev.length
  const out = next.map((it, i) => {
    const was = old.get(it.key)
    if (!was || was.type !== it.type) return ((same = false), it)
    if (it.type === "tools" && was.type === "tools") {
      // A group grows, and its calls get their results: keep the calls that didn't change.
      const calls = new Map(was.calls.map((c) => [c.id, c]))
      it.calls = it.calls.map((c) => {
        const o = calls.get(c.id)
        return o && shallowEqual(o, c) ? o : c
      })
      if (sameList(was.calls, it.calls)) it = was
    } else if (shallowEqual(was, it)) it = was
    if (it !== prev[i]) same = false
    return it
  })
  return same ? prev : out
}

export function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Reflect.get(a, k) === Reflect.get(b, k))
}

const sameList = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])
