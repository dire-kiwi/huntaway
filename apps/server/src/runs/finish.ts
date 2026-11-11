import type { Notice, Status, Task, Timestamp, Todo } from "@huntaway/contracts"
import { TODO_NUDGE, todoList } from "../prompts/todoNudge.ts"
import type { RunExitStatus } from "../platform/Changes.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { Outcome } from "./Run.ts"
import type { Run, RunKind } from "./Run.ts"

// The end of a run (docs/plan/07-agents.md, When a run ends; inventory 01, section 9, "What finish writes to the
// task"; huntaway's runner/output.ts `on_exit` and `finish`, runner/todos.ts, runner/plan.ts): plain functions over the
// facts the end gathers under the task's lock. Merges (M4), workflows (6.6), reviews and summaries (5.x) and routines'
// reports (6.5) give facts that are false or absent until their areas come; their rows are kept, in the old order.

/** How much of `err.log` a failure quotes. */
const STDERR_TAIL = 4000

/** The attention reason of a task whose plan waits for the user (HA-198). */
export const PLAN_READY = "Plan ready for review"
/** The attention reason of a merging task whose merge waits for the user's approval. */
export const APPROVAL = "Approve or deny the merge"

/** A string cut to `max` characters, marked. */
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/** The first line of `s`, or null for an empty one (Rust's `s.lines().next()`). */
const firstLine = (s: string): string | null => (s === "" ? null : (s.split("\n")[0]?.replace(/\r$/u, "") ?? null))

/**
 * How a run ended (the old `on_exit`), the last turn's result deciding: a stop is cancelled; a last result that failed
 * is a failure with its error; exit 0 after a result is ok; anything else failed, with how it exited and the end of its
 * `err.log`.
 */
export const outcomeOf = (run: Pick<Run, "stop" | "result_error" | "saw_result">, exit: RunExitStatus, errorTail: string): Outcome => {
  if (run.stop !== "none") return Outcome.cancelled
  if (run.result_error !== null) return Outcome.failed(run.result_error)
  if (exit.code === 0 && run.saw_result) return Outcome.ok
  const how =
    exit.error ??
    (exit.code !== null
      ? `the agent exited with code ${exit.code}`
      : exit.signal !== null
        ? `the agent was killed by signal ${exit.signal}`
        : "the agent exited unexpectedly")
  const stderr = errorTail.trim()
  return Outcome.failed(stderr === "" ? how : `${how}\n${cut(stderr, STDERR_TAIL)}`)
}

/** The items of a task's todo list that aren't completed. */
export const unfinished = (task: Pick<Task, "kind" | "todos">): ReadonlyArray<Todo> =>
  task.kind === "task" ? task.todos.filter((x) => x.status !== "completed") : []

/** The attention reason of a task its list still held after its agent was asked to finish it. */
export const todoReason = (items: ReadonlyArray<Todo>): string => cut(`Todo list unfinished: ${items.map((x) => x.text).join("; ")}`, 200)

/** Whether the last message the agent was sent is the board's nudge: it was asked to finish its list, and hasn't. */
export const nudged = (last: { readonly text: string; readonly auto?: boolean } | null): boolean => last?.auto === true && last.text.startsWith(TODO_NUDGE)

/** A thread that is the profile's own (the assistant, its routines, the pens threads): never held, never reviewed. */
type Lasting = "assistant" | "pens" | "routine" | null

const lastingOf = (task: Pick<Task, "kind" | "task_type" | "project_id">): Lasting => {
  if (task.kind !== "task" || task.project_id !== null) return null
  if (task.task_type === "assistant") return "assistant"
  if (task.task_type === "pens" || task.task_type === "pen") return "pens"
  if (task.task_type === "routine") return "routine"
  return null
}

/** What the end of a run knows. */
export interface FinishFacts {
  readonly outcome: Outcome
  readonly run: Pick<Run, "kind" | "attention" | "finished">
  readonly task: Pick<Task, "kind" | "status" | "merging" | "remerge" | "merge_approval" | "task_type" | "project_id" | "todos" | "limit_reset_at">
  /** The task's usage limit resets in the future (it ran out in this run). */
  readonly limitAhead: boolean
  /** Its profile has a task out of usage wait for the reset rather than need attention. */
  readonly limitWait: boolean
  /** Its config's name, for what the thread is told. */
  readonly configName: string
  /** Its merge target was closed or deleted while it ran (M4: never yet). */
  readonly mergeHeld: string | null
  /** Its project's workflow moves a merged task to Done (6.6: never yet). */
  readonly mergesToDone: boolean
  /** The run may have written or revised only the task's plan, and no other work (HA-198). */
  readonly planOnly: boolean
  /** The last message its agent was sent was the board's nudge to finish its todo list. */
  readonly nudged: boolean
  /** The end of the Ready for merge column, for a task rejoining the merge queue. */
  readonly endOfMergeQueue: number
}

/** What the end of a run writes to its task, says in its thread, and does next. */
export interface FinishDecision {
  /** Said in the thread, in order, before what is queued is sent. */
  readonly notices: ReadonlyArray<Pick<Notice, "level" | "text"> & { readonly detail?: string | undefined }>
  /** The task's columns, `running: false` among them. */
  readonly columns: TaskColumns
  /** Send what is queued first (the card then stays where it is), unless the config is out of usage. */
  readonly sendQueued: boolean
  /** Ask the agent to finish its todo list: the items it hasn't. */
  readonly nudge: ReadonlyArray<Todo> | null
}

type Column = readonly [Status | null, string | null]

/** The old `finish`, first match wins. */
export const decideFinish = (f: FinishFacts): FinishDecision => {
  const notices: Array<FinishDecision["notices"][number]> = []
  const failed = f.outcome._tag === "Failed" ? f.outcome.reason : null
  const isTask = f.task.kind === "task"
  if (f.run.kind === "compact") {
    // A compaction never moves the card.
    if (f.outcome._tag === "Cancelled") notices.push({ level: "warning", text: "Compacting stopped" })
    else if (failed !== null) notices.push({ level: "error", text: "Compacting failed", detail: failed })
    return { notices, columns: { running: false }, sendQueued: true, nudge: null }
  }
  const limit = failed !== null && f.limitAhead ? f.task.limit_reset_at : null
  const waitReset = limit !== null && isTask && !f.task.merging && f.limitWait
  const lasting = lastingOf(f.task)
  let mergeFinished = false
  let column: Column
  if (f.outcome._tag === "Cancelled") {
    notices.push({ level: "warning", text: "Run stopped" })
    column = ["needs_attention", "Stopped by user"]
  } else if (failed !== null && limit !== null) {
    notices.push({ level: "warning", text: `${f.configName} is out of usage`, detail: failed })
    if (waitReset) {
      notices.push({ level: "info", text: `Waiting for ${f.configName}'s usage limit to reset`, detail: `It resets at ${limit}` })
      column = ["in_progress", null]
    } else column = ["needs_attention", firstLine(failed) ?? "Out of usage"]
  } else if (failed !== null) {
    notices.push({ level: "error", text: "Run failed", detail: failed })
    column = ["needs_attention", `Run failed: ${firstLine(failed) ?? ""}`]
  } else if (f.run.attention !== null) column = ["needs_attention", f.run.attention]
  // The agent marked its own task done (after merging it, say).
  else if (f.task.status === "done") column = [null, null]
  else if (isTask && f.mergeHeld !== null) column = ["needs_attention", f.mergeHeld]
  else if (f.task.merging && f.task.merge_approval === "pending") column = ["needs_attention", APPROVAL]
  else if (f.task.merging && f.run.finished && f.mergesToDone) {
    column = [null, null]
    mergeFinished = true
  } else if (f.task.merging) column = ["needs_attention", "The agent finished without marking the task merged"]
  else if (f.task.remerge) column = ["ready_for_merge", null]
  else if (lasting === "assistant" || lasting === "pens") column = ["todo", null]
  else if (lasting === "routine") column = ["done", null]
  else column = ["in_review", null]
  // A run that only wrote or revised the plan: it waits for the user (with checkpoints, M4; until then never).
  if (isTask && column[0] === "in_review" && f.planOnly) column = ["needs_attention", PLAN_READY]
  // An unfinished todo list holds the task in In progress (HA-330): its agent is asked to finish it, once.
  let nudge: ReadonlyArray<Todo> | null = null
  const leaving = isTask && column[0] !== null && column[0] !== "in_progress" && column[0] !== "needs_attention"
  const items = leaving && f.task.status === "in_progress" && lasting === null ? unfinished(f.task) : []
  if (items.length > 0) {
    if (f.nudged) column = ["needs_attention", todoReason(items)]
    else {
      column = [null, column[1]]
      nudge = items
    }
  }
  const [status, reason] = column
  const columns: { -readonly [K in keyof TaskColumns]: TaskColumns[K] } = { running: false, attention_reason: reason }
  if (waitReset) columns.waiting = true
  // Out of the merge queue, so it isn't asked to merge again while the workflow moves it on.
  if (mergeFinished) columns.merging = false
  if (isTask && status === "needs_attention" && f.mergeHeld !== null) {
    columns.merging = false
    columns.remerge = false
    columns.merge_approval = null
  }
  if (isTask && status !== null) columns.status = status
  if (isTask && status === "ready_for_merge") {
    // At the back of the queue, as the tasks behind it moved up while it was away.
    columns.merging = true
    columns.remerge = false
    columns.position = f.endOfMergeQueue
    notices.push({ level: "info", text: "Back in the merge queue" })
  }
  return { notices, columns, sendQueued: limit === null, nudge }
}

/** The notice before the nudge: the list the task stays in progress for. */
export const nudgeNotice = (items: ReadonlyArray<Todo>) => ({
  level: "info" as const,
  text: "The todo list isn't complete, so the task stays in progress",
  detail: todoList(items),
})

/** Whether a stored limit is still ahead of `now`. */
export const isAhead = (at: Timestamp | null, now: Timestamp): boolean => at !== null && at > now

/** A run's kind as the end of it treats it. */
export type EndedKind = RunKind
