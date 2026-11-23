import { agentWaiting, backgroundIdle, STATUSES } from "@huntaway/client"
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

/** What a task's agent is doing: working, waiting on something it said (`wait`), idle with background work, or yet to start. */
export interface AgentNote {
  readonly state: "working" | "waiting" | "idle" | "queued"
  readonly label: string
}

type Noted = Pick<Task, "running" | "background_work" | "waiting" | "agent_wait" | "status">

/**
 * What a task's agent is doing, in a word or a few, or null when it has none running or due. A task in Needs attention
 * whose agent runs is waiting on the user (a prompt, a question), which its status says: not "Working".
 */
export const agentNote = (t: Noted): AgentNote | null => {
  if (t.running) {
    if (t.status === "needs_attention") return null
    const wait = agentWaiting(t)
    if (wait != null) return { state: "waiting", label: wait.reason === null || wait.reason === "" ? "Waiting" : `Waiting: ${wait.reason}` }
    return backgroundIdle(t) === null ? { state: "working", label: "Working" } : { state: "idle", label: "Idle, background work goes on" }
  }
  return t.waiting ? { state: "queued", label: "Waiting to start" } : null
}

/** The tasks whose key or title has every word of `text` (pure; any case). All of them for no words. */
export function searchTasks<T extends Pick<Task, "key" | "title">>(tasks: ReadonlyArray<T>, text: string): ReadonlyArray<T> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
  if (words.length === 0) return tasks
  return tasks.filter((t) => {
    const hay = `${t.key} ${t.title}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The statuses a project's list shows folded until asked for: what is put away, not what is going on. */
export const FOLDED: ReadonlyArray<Status> = ["backlog", "done"]
