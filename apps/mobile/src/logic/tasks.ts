import { STATUSES } from "@huntaway/client"
import type { Status, Task } from "@huntaway/contracts"

// A project's tasks as the phone lists them (the old app's tasks.ts): by status, what needs the user first.

/** The order the project screen lists statuses in. */
export const STATUS_ORDER: ReadonlyArray<Status> = ["needs_attention", "in_progress", "in_review", "ready_for_merge", "todo", "backlog", "done"]

/** How many done tasks a project shows: the latest. */
export const DONE_SHOWN = 20

export const statusLabel = (status: Status): string => STATUSES.find((st) => st.id === status)?.label ?? status

export interface TaskGroup<T> {
  readonly status: Status
  readonly label: string
  readonly tasks: ReadonlyArray<T>
}

type Listed = Pick<Task, "kind" | "status" | "position" | "done_at" | "task_type">

/**
 * Tasks grouped by status in `STATUS_ORDER`, empty groups left out (pure): only the board's tasks (not reviews,
 * assistants or routines), each group by position, Done the latest `DONE_SHOWN` by when they were done.
 */
export function groupTasks<T extends Listed>(tasks: ReadonlyArray<T>): ReadonlyArray<TaskGroup<T>> {
  const listed = tasks.filter((t) => t.kind === "task" && t.task_type !== "assistant" && t.task_type !== "routine")
  return STATUS_ORDER.flatMap((status) => {
    const of = listed.filter((t) => t.status === status)
    const sorted =
      status === "done"
        ? of.toSorted((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? "")).slice(0, DONE_SHOWN)
        : of.toSorted((a, b) => a.position - b.position)
    return sorted.length === 0 ? [] : [{ status, label: statusLabel(status), tasks: sorted }]
  })
}

/** What a task's agent is doing, in a few words, or null when it has none running. */
export const agentState = (t: Pick<Task, "running" | "background_work" | "waiting">): string | null => {
  if (t.running) return t.background_work?.idle === true ? "Agent idle, its background work goes on" : "Agent running"
  return t.waiting ? "Waiting to start" : null
}
