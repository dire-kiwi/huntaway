import { Result } from "effect"
import { note as prNote } from "../../github/prWatch/pr.ts"
import type { AgentWait, ReviewState, Status, Task, TaskId, WaitTask } from "@huntaway/contracts"

// The `wait` tool's rules as plain functions (docs/plan/inventory/03-mcp.md 2.8; huntaway's mcp/wait.ts): how long a
// wait lasts, how it ended, and what the tool tells the agent about it. Copied word for word.

/** A wait's default period with tasks or a pull request to watch (seconds). */
export const DEFAULT_SECS = 600
/** The longest a wait can be (seconds). */
export const MAX_SECS = 3600

/**
 * The longest a wait with neither tasks to watch nor a command can be (and its default). Only a message or a subagent
 * can end one early, so agents waiting for CI or a deploy that way would sleep on long after it's ready: they wait again
 * (and check) every so often instead, or give a command that exits once it's ready.
 */
export const UNWATCHED_MAX_SECS = 30

/**
 * The longest a wait with a command can be (as long as Claude Code's Bash calls at most). A command is the agent's own
 * check, and one that never succeeds (a loop on a file it misnamed, HA-301) would otherwise keep it asleep for an hour:
 * this way it hears how the command is doing (its output so far) every ten minutes, and waits again if it's fine.
 */
export const COMMAND_MAX_SECS = 600

/** The shortest wait period (seconds). */
export const SHORTEST_SECS = 1

/** How often a wait checks for what no task event announces (its run being stopped). */
export const TICK = "5 seconds"

/** Why a wait ended. */
export type Ended =
  /** The wait period is over. */
  | { readonly _tag: "Timeout" }
  /** These watched tasks changed status or were deleted, and (if any) these ones' reviews finished, with how. */
  | {
      readonly _tag: "Tasks"
      readonly tasks: ReadonlyArray<TaskId>
      readonly reviews?: ReadonlyArray<{ readonly id: TaskId; readonly state: ReviewState }>
    }
  /** A subagent finished, with its id, status and summary. */
  | { readonly _tag: "Subagent"; readonly agent: unknown }
  /** A message was sent to the agent. */
  | { readonly _tag: "Message" }
  /** The run was stopped. */
  | { readonly _tag: "Stopped" }
  /** The run carried on with other work, or the wait was cleared under it. */
  | { readonly _tag: "Resumed" }
  /** The task was moved to this column. */
  | { readonly _tag: "Moved"; readonly status: Status }
  /** The wait's command exited, with this code (null if a signal ended it) and the end of its output. */
  | { readonly _tag: "Command"; readonly code: number | null; readonly output: string }
  /** There's news about the wait's pull request, or it couldn't be read (`PrWatch`'s `News`). */
  | { readonly _tag: "PullRequest"; readonly news: unknown }

/** What the tool's `ended` says, for each way a wait ends. */
const ENDED_NAMES: { readonly [T in Ended["_tag"]]: string } = {
  Timeout: "timeout",
  Tasks: "tasks_changed",
  Subagent: "subagent_finished",
  Message: "message",
  Stopped: "stopped",
  Resumed: "resumed",
  Moved: "task_moved",
  Command: "command_exited",
  PullRequest: "pull_request",
}

/** What the tool's `ended` says. */
export const endedName = (e: Ended): string => ENDED_NAMES[e._tag]

/** How a finished review went, as the tool's note says it. */
const REVIEW_ENDED: { readonly [S in ReviewState]: string } = {
  running: "is running",
  passed: "passed",
  issues: "found issues",
  failed: "failed",
  stopped: "was stopped",
}

/** What the tool tells the agent about how its wait ended, given the tasks it watched. */
export const note = (e: Ended, watched: ReadonlyArray<WaitTask>): string => {
  const key = (id: TaskId) => watched.find((w) => w.id === id)?.key ?? id
  if (e._tag === "PullRequest") return prNote(e.news)
  if (e._tag === "Tasks") {
    const parts: Array<string> = []
    if (e.tasks.length > 0) parts.push(`${e.tasks.map(key).join(", ")} changed status`)
    for (const r of e.reviews ?? []) parts.push(`${key(r.id)}'s review ${REVIEW_ENDED[r.state]}`)
    return `${parts.join("; ")} (see tasks).`
  }
  if (e._tag === "Moved") return `The task was moved to ${e.status} on the board.`
  if (e._tag === "Command") {
    return e.code !== null ? `Your command exited with code ${e.code} (see command.output).` : "Your command was ended by a signal (see command.output)."
  }
  return NOTES[e._tag]
}

/** The notes that say nothing more than how the wait ended. */
const NOTES: { readonly [T in Exclude<Ended["_tag"], "Tasks" | "Moved" | "Command" | "PullRequest">]: string } = {
  Timeout: "The wait period is over. Check on what you were waiting for, and wait again if it isn't ready yet.",
  Subagent: "A subagent finished (see subagent).",
  Message: "A message was sent to you; you'll read it once this call returns.",
  Stopped: "The run was stopped.",
  Resumed: "The wait ended because you carried on with other work (another tool call).",
}

/** What the note adds when the wait ended otherwise while its command ran. */
export const COMMAND_STOPPED = "Your command hadn't exited, so it was stopped (its output so far is in command.output)."

/** What a new wait asks for, as far as its period goes. */
export interface PeriodRequest {
  readonly seconds: number | null
  readonly tasks: ReadonlyArray<unknown>
  readonly command: string | null
  readonly pullRequest: boolean
}

/**
 * How long a new wait asked for lasts (in seconds), or why it doesn't start: see `UNWATCHED_MAX_SECS` (and
 * `COMMAND_MAX_SECS`). A blank command is none.
 */
export const period = (req: PeriodRequest): Result.Result<number, string> => {
  const hasCommand = (req.command ?? "").trim() !== ""
  const unwatched = req.tasks.length === 0 && !hasCommand && !req.pullRequest
  const max = unwatched ? UNWATCHED_MAX_SECS : hasCommand ? COMMAND_MAX_SECS : MAX_SECS
  const secs = req.seconds
  if (secs === null) return Result.succeed(unwatched ? UNWATCHED_MAX_SECS : DEFAULT_SECS)
  if (unwatched && secs > max) {
    return Result.fail(
      `The wait didn't start: without a command, tasks or a pull request, a wait lasts ${max} seconds at most, because little but a ` +
        `message or a subagent can end it early, so it would carry on long after what you're waiting for is ready. Either give the ` +
        `pull_request you're waiting on (its checks, reviews or merge), a command that exits once it's ready (e.g. 'until curl -sf ` +
        `https://example.com/health; do sleep 15; done'), list the tasks you're waiting for in tasks, or wait ${max} seconds at a ` +
        `time, checking in between.`,
    )
  }
  return Result.succeed(Math.min(Math.max(secs, SHORTEST_SECS), max))
}

/** The wait stored for the call `call`, if it's that call again (retried after a restart), which carries on with it rather than starting over. */
export const resuming = (task: Pick<Task, "agent_wait">, call: string): AgentWait | null =>
  task.agent_wait !== null && task.agent_wait.call_id === call ? task.agent_wait : null

/** The facts of a watched task the check reads. */
export interface Watched {
  readonly status: Status
  readonly review: { readonly state: ReviewState; readonly updated_at: string } | null
}

/**
 * Whether the watched tasks end the wait: one whose status differs from the one the wait has, or that is gone, has
 * changed; one whose review finished since the wait began (its `review_at` is known, a review not running whose
 * `updated_at` differs) has its review ended. A new round's start doesn't count, nor does its end before the wait.
 */
export const tasksChanged = (watched: ReadonlyArray<WaitTask>, now: (id: TaskId) => Watched | null): Ended | null => {
  const changed: Array<TaskId> = []
  const reviews: Array<{ readonly id: TaskId; readonly state: ReviewState }> = []
  for (const w of watched) {
    const t = now(w.id)
    if (t === null || t.status !== w.status) changed.push(w.id)
    const r = t?.review ?? null
    if (w.review_at !== undefined && r !== null && r.state !== "running" && r.updated_at !== w.review_at) reviews.push({ id: w.id, state: r.state })
  }
  if (changed.length === 0 && reviews.length === 0) return null
  return reviews.length > 0 ? { _tag: "Tasks", tasks: changed, reviews } : { _tag: "Tasks", tasks: changed }
}
