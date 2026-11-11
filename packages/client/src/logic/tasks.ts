import { DateTime } from "effect"
import type { BackgroundItem, BackgroundWork, PermissionMode, PrChecks, Project, Status, Task, TaskServer, Todo, TrackedItem } from "@huntaway/contracts"
import { isAssistants } from "./assistant.ts"
import { isPenThreads } from "./pens.ts"

// The task predicates and constants of the old packages/client's tasks.ts, kept by name. A task from the contract has
// every field, so the old fallbacks for hosts that left one out are gone.

/** The board's columns, in order, with their names. */
export const STATUSES: ReadonlyArray<{ readonly id: Status; readonly label: string }> = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "in_review", label: "In review" },
  { id: "ready_for_merge", label: "Ready for merge" },
  { id: "done", label: "Done" },
  // Parked work: the board puts it first, in a collapsible column (see TaskBoard).
  { id: "backlog", label: "Backlog" },
]

/** The statuses a host knows about: all of them (the old version gates are gone). */
export const hostStatuses = (_host?: unknown): typeof STATUSES => STATUSES

export const PERMISSION_MODES = [
  { id: "default", label: "Ask", description: "Approve each tool call in the thread" },
  { id: "acceptEdits", label: "Accept edits", description: "Approve file edits automatically, ask for the rest" },
  { id: "auto", label: "Auto", description: "Claude's classifier approves routine actions and blocks risky ones" },
  { id: "plan", label: "Plan", description: "Explore read-only and propose a plan for approval first" },
  { id: "dontAsk", label: "Don't ask", description: "Never prompt; deny anything not already allowed" },
  { id: "bypassPermissions", label: "Bypass", description: "Approve everything without asking" },
] as const satisfies ReadonlyArray<{ readonly id: PermissionMode; readonly label: string; readonly description: string }>

/**
 * The unfinished items of `t`'s todo list that hold it in In progress when it is moved to `to`: none unless it is moved
 * out of In progress, to anywhere but Needs attention.
 */
export function heldTodos(t: Pick<Task, "status" | "todos">, to: Status): ReadonlyArray<Todo> {
  if (t.status !== "in_progress" || to === "in_progress" || to === "needs_attention") return []
  return t.todos.filter((x) => x.status !== "completed")
}

/** Its merge waits for the user's approval: its agent summarises what will be merged, then the user approves or denies it. */
export const mergeAwaitsApproval = (t: Pick<Task, "merging" | "merge_approval">): boolean => t.merging && t.merge_approval === "pending"

/** Waiting in Ready for merge for another task in its project to finish merging. */
export const mergeQueued = (t: Task): boolean => t.merging && t.status === "ready_for_merge" && !t.running && !mergeAwaitsApproval(t)

/** Stepped out of the merge queue to make changes, and rejoins it when its agent is done. */
export const rejoinsMerge = (t: Pick<Task, "remerge" | "status">): boolean => t.remerge && (t.status === "in_progress" || t.status === "needs_attention")

/** Its agent is running but waiting for something (the `wait` tool), not working. */
export const agentWaiting = (t: Pick<Task, "running" | "agent_wait">): Task["agent_wait"] => (t.running ? t.agent_wait : null)

/** Its agent's turn has ended and only background work it does not wait on goes on (a dev server): idle, not working. */
export const backgroundIdle = (t: Pick<Task, "running" | "background_work">): BackgroundWork | null =>
  t.running && t.background_work?.idle ? t.background_work : null

/** Its agent is working: running, and neither waiting (the `wait` tool) nor idle with background work left. */
export const agentWorking = (t: Task): boolean => t.running && !agentWaiting(t) && !backgroundIdle(t)

/** What a background task is, in a few words: its description, or its command. */
export const backgroundLabel = (b: BackgroundItem): string => b.description || b.command || (b.kind === "subagent" ? "a subagent" : "a background command")

/** "Idle: … its background work goes on: npm run dev, a watcher", for a task idle with background work. */
export function idleTitle(w: BackgroundWork): string {
  const shown = w.tasks.filter((b) => b.kind !== "subagent")
  return `Idle: the agent has ended its turn, and its background work goes on${shown.length ? `: ${shown.map(backgroundLabel).join(", ")}` : ""}`
}

/**
 * Where a server the task's processes listen on is opened: on this machine, unless it listens on every address, when it
 * is on the board's host as the page reaches it (`here`, the page's hostname).
 */
export function serverUrl(s: Pick<TaskServer, "address" | "port">, here: string): string {
  const any = s.address === "0.0.0.0" || s.address === "::"
  const host = any && here && here !== "localhost" && here !== "127.0.0.1" && here !== "[::1]" ? here : "localhost"
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${s.port}`
}

/** Queued in In progress until the tasks it depends on are merged. */
export const dependencyQueued = (t: Pick<Task, "waiting" | "status" | "running" | "limit_reset_at">): boolean =>
  t.waiting && t.status === "in_progress" && !t.running && !t.limit_reset_at

/** Queued in In progress until its config's usage limit resets, when its agent carries on. */
export const limitQueued = (t: Pick<Task, "waiting" | "status" | "running" | "limit_reset_at">): boolean =>
  t.waiting && t.status === "in_progress" && !t.running && !!t.limit_reset_at

const millis = (at: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(at))

/** Its agent stopped because its config ran out of usage, which has not reset by `now` (milliseconds): it can wait for the reset. */
export const outOfUsage = (t: Pick<Task, "waiting" | "running" | "limit_reset_at">, now: number): boolean =>
  !t.waiting && !t.running && !!t.limit_reset_at && millis(t.limit_reset_at) > now

export const isMerged = (t: Pick<Task, "status" | "resolution">): boolean => t.status === "done" && (t.resolution ?? "done") === "done"

/** How long a task stays in Done before it is archived. */
export const ARCHIVE_AFTER_MS = 2 * 24 * 3600_000

/** Done for ARCHIVE_AFTER_MS by `now` (milliseconds): off the kanban board, in the list view's Archived section. */
export const isArchived = (t: Pick<Task, "status" | "done_at">, now: number): boolean =>
  t.status === "done" && !!t.done_at && millis(t.done_at) <= now - ARCHIVE_AFTER_MS

/**
 * In review, and the agent has not gone back to work since: its review passed, or it was not reviewed. One being
 * reviewed, or whose review found issues or did not finish, is not ready yet.
 */
export const readyToCheck = (t: Pick<Task, "status" | "running" | "review">): boolean =>
  t.status === "in_review" && !t.running && (!t.review || t.review.state === "passed")

/** Whether a message sent to the task's running agent reaches it at once rather than waiting for its run to end. */
export const runningAgentSteers = (t: Pick<Task, "steerable">): boolean => t.steerable

/** The Stop button's title for the task's running agent. */
export const stopTitle = (t: Pick<Task, "queued_message" | "steering">, steers: boolean): string =>
  t.queued_message
    ? "Stop and send the queued message now"
    : !steers
      ? "Stop the agent"
      : t.steering.length
        ? "Stop: the agent ends its turn, then reads your message"
        : "Stop: the agent ends its turn, and you can reply to carry on"

/** A task's summaries: one from each summarizer. */
export const summariesOf = (t: Pick<Task, "summaries">): Task["summaries"] => t.summaries

/** A review thread that summarises its task's changes rather than reviewing them. */
export const isSummaryThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "review" && t.task_type === "summary"
/** A workflow's agent step's thread, which is a review thread of the task. */
export const isWorkflowThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "review" && t.task_type === "workflow"

/** A scratch task: its agent works in the task's own folder, with no worktree, on whatever it is asked. */
export const isScratch = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "scratch"

/** A group task: in no project, it plans the work of its group's projects. */
export const isGroupTask = (t: Pick<Task, "kind" | "project_id" | "group_name">): boolean => t.kind === "task" && !t.project_id && !!t.group_name

/**
 * What goes before a task's number: its project's key, `G` for a group task, `S` for a scratch task and the pens' threads,
 * `A` for its profile's assistant and its routines' threads.
 */
export const keyPrefix = (t: Pick<Task, "kind" | "task_type" | "project_id" | "group_name">, project?: Pick<Project, "key">): string =>
  project?.key ?? (t.project_id ? "T" : t.group_name ? "G" : isScratch(t) || isPenThreads(t) ? "S" : isAssistants(t) ? "A" : "T")

/** The task's key (`HE-2`): the server works it out, so no client derives it. */
export const taskKey = (t: Pick<Task, "key">): string => t.key

/** Where the task's agent works, if not where its kind and project say and the folder is one to show. */
export const ownWorkDir = (t: Pick<Task, "work_dir">): string | null => (t.work_dir && /^[/~]/.test(t.work_dir) ? t.work_dir : null)

/** What a tracked item shows as (the server's effective status). */
export type TrackedStatus = TrackedItem["status"]

/**
 * What a tracked item shows as: done once the task it follows is done, unless it failed; and while it says it is
 * working or waiting on that task, waiting on the user once the task needs their attention or is in review.
 */
export function trackedStatus(item: Pick<TrackedItem, "status">, task: Pick<Task, "status"> | undefined): TrackedStatus {
  if (item.status === "failed" || item.status === "done" || !task) return item.status
  if (task.status === "done") return "done"
  if ((item.status === "working" || item.status === "waiting_task") && (task.status === "needs_attention" || task.status === "in_review")) return "waiting_user"
  return item.status
}

const prKey = (url: string): string | undefined => /^https?:\/\/(?:www\.)?([^/]+\/[^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url)?.slice(1).join("#").toLowerCase()

/** How the checks of the task's pull request stood at the board's latest read of it, if it has read the one the task has now. */
export function prChecks(t: Pick<Task, "pr_checks" | "pr_url">): PrChecks | null {
  const c = t.pr_checks
  if (!c || !t.pr_url) return null
  const key = prKey(t.pr_url)
  return key !== undefined && key === prKey(c.url) ? c : null
}

/** The failed checks of an open task's pull request, if the board's latest read of it found some. */
export function failedChecks(t: Pick<Task, "pr_checks" | "pr_url" | "status">): PrChecks | null {
  const c = prChecks(t)
  return c && c.outcome === "failed" && t.status !== "done" ? c : null
}
