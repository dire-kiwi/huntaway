// HE-119: a set's task across repositories in Ready for merge waits until every open task of its set is there too, then
// each merges in its own project's queue. Its card and its Details say what it waits for, as they do for a stack level.
import { setMergeWaits, STATUSES, type HostTask as Task } from "@huntaway/client"
import { useBoard } from "../../state/board"

const column = (t: Task) => (t.status === "ready_for_merge" ? "waiting for approval" : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status))

/** What set task `task`'s merge waits for in Ready for merge, or null when it doesn't (a text, so the board's changes elsewhere don't redraw it). */
export function useSetWait(task: Task): string | null {
  return useBoard((s) => {
    const waits = setMergeWaits(task, Object.values(s.tasks))
    if (waits.length === 0) return null
    const list = waits.map((t) => `${t.key} (${column(t)})`).join(", ")
    return `Waits for the rest of its set: ${list}. Once every open task of the set is in Ready for merge, each merges in its own project's queue.`
  })
}
