import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"
import { useSubagentFocus, type Subagent } from "./subagentView"
import type { Call, ThreadModel } from "./threadModel"

type ThreadData = ThreadModel & {
  running: boolean
  cwd?: string | null | undefined
  hostId: string
  taskId: string
  /** Keeps the thread scrolled to its end, if it was there, after a part of it grew on its own. */
  follow: () => void
}

/** A thread with nothing in it. */
const EMPTY: ThreadData = {
  items: [],
  results: new Map(),
  subagents: new Map(),
  callParent: new Map(),
  lastSent: 0,
  childItems: new Map(),
  running: false,
  hostId: "",
  taskId: "",
  follow: () => {},
}

/**
 * The thread's model, for its rows to pick what they show from (useThread). It's the same object for
 * the thread's life, so a new model only redraws the rows whose pick changed (see buildItemModel).
 */
export class ThreadSource {
  private listeners = new Set<() => void>()
  data: ThreadData
  /** Empty until its thread's first `update`, which comes before it's first shown. */
  constructor(data: ThreadData = EMPTY) {
    this.data = data
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  publish() {
    for (const l of this.listeners) l()
  }
  /** The thread's new model, once it's shown: the rows whose pick of it changed redraw. */
  update(data: ThreadData) {
    this.data = data
    this.publish()
  }
}

export const ThreadCtx = createContext<ThreadSource | null>(null)

const NO_SOURCE = new ThreadSource()

/** Part of the thread's model. `pick` mustn't make a new object each time (a Map's `get` is fine). */
export function useThread<T>(pick: (t: ThreadData) => T): T {
  // Rows are only drawn inside a thread, which provides its source; outside one they see an empty thread.
  const source = useContext(ThreadCtx) ?? NO_SOURCE
  return useSyncExternalStore(source.subscribe, () => pick(source.data))
}

/**
 * How a subagent's call is drawn among the tool calls (subagents.tsx's `SubagentRow`, provided by `SubagentRows`). A
 * subagent's row holds its own rows, so the row is given to the tool calls here rather than imported by them, which
 * would make the row modules import each other. Without one, a subagent's call is drawn as a plain tool call.
 */
export const SubagentRowCtx = createContext<((call: Call, sub: Subagent) => ReactNode) | null>(null)

/** Whether rows are in the main conversation, rather than in a subagent's own thread shown in its place. */
export const InMainThread = createContext(true)

/**
 * The request to reveal a subagent in this thread's main conversation, while its row hasn't shown
 * itself yet (see useSubagentFocus). Rows in a subagent's own thread leave it alone.
 */
export function usePendingFocus() {
  const taskId = useThread((t) => t.taskId)
  const main = useContext(InMainThread)
  return useSubagentFocus((s) => (main && s.focus && s.focus.taskId === taskId && s.focus.n > s.handled ? s.focus : null))
}

/** A subagent and the subagents that started it, innermost first. */
export function lineage(subagents: ReadonlyMap<string, Subagent>, id: string): string[] {
  const out: string[] = []
  for (let cur: string | null | undefined = id; cur && !out.includes(cur); cur = subagents.get(cur)?.parent) out.push(cur)
  return out
}
