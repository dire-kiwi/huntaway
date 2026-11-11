import { Schema } from "effect"
import { TaskId } from "../ids.ts"
import { Effort } from "../task.ts"
import { RequestResolution } from "./Request.ts"
import { ThreadPermissionMode } from "./Thread.ts"

// What a client asks of a thread, as the old `POST /tasks/{id}/thread/commands` took it. `thread_id` may be left out;
// another task's is refused. Left out of the old protocol, as never taken: `send`'s `attachments` (files are uploaded
// and linked in the text) and `client_id`, and `rewind`'s `turn_id` (items have no turn).

const commandBase = { thread_id: Schema.optionalKey(TaskId) }

/** Send the agent a message: it starts a turn, steers the running one, or is queued. */
export const SendCommand = Schema.Struct({ type: Schema.Literal("send"), ...commandBase, text: Schema.String })
export type SendCommand = typeof SendCommand.Type

/** Stop the running turn. */
export const InterruptCommand = Schema.Struct({ type: Schema.Literal("interrupt"), ...commandBase })
export type InterruptCommand = typeof InterruptCommand.Type

/** Answer an open request. */
export const RespondCommand = Schema.Struct({
  type: Schema.Literal("respond"),
  ...commandBase,
  request_id: Schema.String,
  resolution: RequestResolution,
})
export type RespondCommand = typeof RespondCommand.Type

/** Change the thread's options. Ones left out stay as they are; at least one is given. */
export const SetOptionsCommand = Schema.Struct({
  type: Schema.Literal("set_options"),
  ...commandBase,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permission_mode: Schema.optionalKey(ThreadPermissionMode),
})
export type SetOptionsCommand = typeof SetOptionsCommand.Type

/** Take the conversation (and, with `branch`, the worktree) back to before the user message `item_id`. */
export const RewindCommand = Schema.Struct({
  type: Schema.Literal("rewind"),
  ...commandBase,
  item_id: Schema.String,
  conversation: Schema.optionalKey(Schema.Boolean),
  branch: Schema.optionalKey(Schema.Boolean),
})
export type RewindCommand = typeof RewindCommand.Type

/** The next turn starts a new conversation with the agent; the items stay. */
export const NewSessionCommand = Schema.Struct({ type: Schema.Literal("new_session"), ...commandBase })
export type NewSessionCommand = typeof NewSessionCommand.Type

/** Compact the agent's context now, in a turn of its own. */
export const CompactCommand = Schema.Struct({ type: Schema.Literal("compact"), ...commandBase })
export type CompactCommand = typeof CompactCommand.Type

export const Command = Schema.Union([SendCommand, InterruptCommand, RespondCommand, SetOptionsCommand, RewindCommand, NewSessionCommand, CompactCommand])
export type Command = typeof Command.Type
