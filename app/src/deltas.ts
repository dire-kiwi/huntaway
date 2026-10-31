import { create } from "zustand";
import { useEffect } from "react";

/**
 * Live streamed assistant text per thread (not yet persisted), in a store of its own: a token
 * changes only it, so the board's selectors don't run again for each one. Only the threads
 * something shows (useDelta) take tokens, and they're added once per animation frame.
 */
export const useDeltas = create<{ deltas: Record<string, string> }>(() => ({ deltas: {} }));

/** How many of what's mounted show each thread's streamed text. */
const watching = new Map<string, number>();
/** Tokens that came since the last frame, by task id. */
const pending = new Map<string, string>();
let frame: number | null = null;

const nextFrame: (fn: () => void) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16) as unknown as number;

/** Puts the tokens that came since the last frame in the store, in one change. */
export function flushDeltas() {
  frame = null;
  if (!pending.size) return;
  const added = [...pending];
  pending.clear();
  useDeltas.setState((st) => {
    const deltas = { ...st.deltas };
    for (const [id, text] of added) deltas[id] = (deltas[id] ?? "") + text;
    return { deltas };
  });
}

/** A streamed token for a task's thread, if something shows it. */
export function addDelta(taskId: string, text: string) {
  if (!watching.has(taskId)) return;
  pending.set(taskId, (pending.get(taskId) ?? "") + text);
  frame ??= nextFrame(flushDeltas);
}

/** Drops a thread's streamed text: it was saved as a message, or the agent started a new block. */
export function clearDelta(taskId: string) {
  pending.delete(taskId);
  if (!(taskId in useDeltas.getState().deltas)) return;
  useDeltas.setState((st) => {
    const deltas = { ...st.deltas };
    delete deltas[taskId];
    return { deltas };
  });
}

/** Shows a thread's streamed text from now on (its tokens go in the store); returns a function that stops it. */
export function watchDelta(taskId: string) {
  watching.set(taskId, (watching.get(taskId) ?? 0) + 1);
  return () => {
    const n = (watching.get(taskId) ?? 1) - 1;
    if (n > 0) watching.set(taskId, n);
    else {
      watching.delete(taskId);
      clearDelta(taskId);
    }
  };
}

/**
 * A thread's streamed text, while the component shows it. Until something shows a thread, its
 * tokens are left out, so a thread opened mid-reply shows the reply from then on.
 */
export function useDelta(taskId: string): string | undefined {
  useEffect(() => watchDelta(taskId), [taskId]);
  return useDeltas((s) => s.deltas[taskId]);
}
