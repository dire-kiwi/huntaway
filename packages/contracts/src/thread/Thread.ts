import { Schema } from "effect"
import { TaskId } from "../ids.ts"
import { Agent, Effort, type PermissionMode } from "../task.ts"
import { Timestamp } from "../time.ts"

// A task's thread (docs/plan/03-domain.md, The thread protocol; the old threads/protocol.ts): items, requests and
// numbered events, the model the server keeps and the clients fold with the same reducer. Fields the old protocol
// omits when unset are `optionalKey` here, and only what the old board produced is declared.

/** idle: no run. running: a run is going. waiting: a run is waiting on an open request. */
export const ThreadStatus = Schema.Literals(["idle", "running", "waiting"])
export type ThreadStatus = typeof ThreadStatus.Type

/**
 * The permission modes as the thread protocol spells them. default: ask through the permission policy. accept_edits:
 * file edits in the working folder are allowed without asking. auto: Claude Code's classifier decides. plan: the agent
 * plans and changes nothing. bypass: nothing is asked, and what would be is allowed. dont_ask: nothing is asked, and
 * what would be is denied. Tasks and projects keep Claude Code's spelling (`PermissionMode`); the converters below go
 * between the two.
 */
export const ThreadPermissionMode = Schema.Literals(["default", "accept_edits", "auto", "plan", "bypass", "dont_ask"])
export type ThreadPermissionMode = typeof ThreadPermissionMode.Type

const toThread: { readonly [M in PermissionMode]: ThreadPermissionMode } = {
  default: "default",
  acceptEdits: "accept_edits",
  auto: "auto",
  plan: "plan",
  dontAsk: "dont_ask",
  bypassPermissions: "bypass",
}

const fromThread: { readonly [M in ThreadPermissionMode]: PermissionMode } = {
  default: "default",
  accept_edits: "acceptEdits",
  auto: "auto",
  plan: "plan",
  dont_ask: "dontAsk",
  bypass: "bypassPermissions",
}

/** A task's permission mode (Claude Code's `acceptEdits`) as the thread protocol names it (`accept_edits`). */
export const toThreadPermissionMode = (mode: PermissionMode): ThreadPermissionMode => toThread[mode]

/** A thread protocol's permission mode (`accept_edits`) as tasks and Claude Code name it (`acceptEdits`). */
export const fromThreadPermissionMode = (mode: ThreadPermissionMode): PermissionMode => fromThread[mode]

/**
 * A thread's own state. It is the task's, worked out from it on every read and never stored: the task's id, which
 * agent runs it, whether a run is going, and the task's title, model, effort, mode, worktree and session.
 */
export const Thread = Schema.Struct({
  /** The task's id. */
  id: TaskId,
  harness: Agent,
  status: ThreadStatus,
  title: Schema.optionalKey(Schema.String),
  /** The model the next turn uses, as the agent names it. */
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permission_mode: Schema.optionalKey(ThreadPermissionMode),
  /** The working folder: the task's worktree. */
  cwd: Schema.optionalKey(Schema.String),
  /** The agent's own session id, which the next run resumes. */
  session_id: Schema.optionalKey(Schema.String),
  created_at: Timestamp,
  updated_at: Schema.optionalKey(Timestamp),
})
export type Thread = typeof Thread.Type
