import { createContext, useContext, useSyncExternalStore } from "react";
import { useSubagentFocus, type Subagent } from "../../../subagents";
import type { ThreadModel } from "../../../threadModel";

type ThreadData = ThreadModel & {
  running: boolean;
  cwd?: string | null;
  hostId: string;
  taskId: string;
  /** Keeps the thread scrolled to its end, if it was there, after a part of it grew on its own. */
  follow: () => void;
};

/**
 * The thread's model, for its rows to pick what they show from (useThread). It's the same object for
 * the thread's life, so a new model only redraws the rows whose pick changed (see buildItemModel).
 */
export class ThreadSource {
  private listeners = new Set<() => void>();
  constructor(public data: ThreadData) {}
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  publish() {
    for (const l of this.listeners) l();
  }
}

export const ThreadCtx = createContext<ThreadSource | null>(null);

/** Part of the thread's model. `pick` mustn't make a new object each time (a Map's `get` is fine). */
export function useThread<T>(pick: (t: ThreadData) => T): T {
  const source = useContext(ThreadCtx)!;
  return useSyncExternalStore(source.subscribe, () => pick(source.data));
}

/** Whether rows are in the main conversation, rather than in a subagent's own thread shown in its place. */
export const InMainThread = createContext(true);

/**
 * The request to reveal a subagent in this thread's main conversation, while its row hasn't shown
 * itself yet (see useSubagentFocus). Rows in a subagent's own thread leave it alone.
 */
export function usePendingFocus() {
  const taskId = useThread((t) => t.taskId);
  const main = useContext(InMainThread);
  return useSubagentFocus((s) => (main && s.focus && s.focus.taskId === taskId && s.focus.n > s.handled ? s.focus : null));
}

/** A subagent and the subagents that started it, innermost first. */
export function lineage(subagents: Map<string, Subagent>, id: string): string[] {
  const out: string[] = [];
  for (let cur: string | null | undefined = id; cur && !out.includes(cur); cur = subagents.get(cur)?.parent) out.push(cur);
  return out;
}
