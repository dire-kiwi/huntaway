import type { HostTask } from "./hostBoard.ts"

// Live task changes (6.8), for notifications: the old `liveTaskChanges`. A board's stream calls these for each task
// event that arrives live, never for what a snapshot or a replay after a reconnect brings, so a task that was waiting
// already when the page loaded (or while it was offline) doesn't notify.

/** Called with a task as it was (undefined if it wasn't on the board) and as an event left it. */
export type LiveTaskChange = (prev: HostTask | undefined, next: HostTask) => void

const listeners = new Set<LiveTaskChange>()

/** Calls `f` for every live task change from now on; the function it gives stops that. */
export function onLiveTaskChange(f: LiveTaskChange): () => void {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}

/** A board's stream tells the listeners of a live change. */
export function liveTaskChanged(prev: HostTask | undefined, next: HostTask): void {
  for (const f of listeners) f(prev, next)
}
