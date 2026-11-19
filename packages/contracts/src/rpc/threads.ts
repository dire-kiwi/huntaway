import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { ConnectionState, SuggestionChoice } from "../assistant.ts"
import { TaskId } from "../ids.ts"
import { Task } from "../task.ts"
import { Auth, RequiredScope } from "../session.ts"
import { ItemPage, ThreadMessage } from "../thread/Snapshot.ts"

/**
 * A task's thread (docs/plan/05-protocol.md, A thread). `threads.watch` sends a snapshot (a window of the last `limit`
 * items, with the items they need, the open requests, `seq` and the reply being written so far), or, with a `since` the
 * day's log still reaches, the events after it; then saved events, deltas and previews as they happen. The server
 * subscribes before it reads the window, so there is no gap to detect. A task with no thread yet is an empty snapshot.
 * `threads.page` has older items, before a window's `start`.
 */
export class ThreadRpcs extends RpcGroup.make(
  Rpc.make("threads.watch", {
    payload: { task_id: TaskId, limit: Schema.Int, since: Schema.optional(Schema.Int) },
    success: ThreadMessage,
    error: NotFound,
    stream: true,
  }).annotate(RequiredScope, "read"),
  Rpc.make("threads.page", {
    payload: { task_id: TaskId, before: Schema.Int, limit: Schema.Int },
    success: ItemPage,
    error: NotFound,
  }).annotate(RequiredScope, "read"),
  /**
   * Answer a question an agent asked with `request_user_input`, from its card (the old `POST
   * /tasks/{id}/questions/{message_id}` `{choices, text}`): the options picked, by label, and what the user typed. The
   * answer is sent to the agent as the user's message; the task as it is after. Not found for no such card; a conflict
   * once it has been answered or the conversation moved on; invalid for an answer that doesn't fit the question.
   */
  Rpc.make("threads.answerQuestion", {
    payload: {
      task_id: TaskId,
      request_id: Schema.String,
      choices: Schema.optional(Schema.Array(Schema.String)),
      text: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: Task,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /**
   * A connection card's Check again (HE-28, the assistant's `request_connection`): whether what it asks for is connected
   * now; if it is, the card settles and the agent is told to carry on. Not found for no such card; a conflict once it has
   * been settled or the conversation moved on.
   */
  Rpc.make("threads.checkConnection", {
    payload: { task_id: TaskId, request_id: Schema.String },
    success: ConnectionState,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /** A connection card's Skip: it settles, and the agent is told to carry on without it. The task as it is after. */
  Rpc.make("threads.skipConnection", {
    payload: { task_id: TaskId, request_id: Schema.String },
    success: Task,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /**
   * A suggestions card's row (HE-61, the assistant's `suggest_task_actions`): do what the user picked with its task, as
   * the board's own buttons do (`keep` does nothing), and mark the row settled. The card is the notice `item_id` of
   * thread `task_id`, the row its `index`. Not found for no such card, row or task; a conflict once the row is settled,
   * or when the task can't be moved so now; invalid for a choice the row doesn't offer. What asks first is the client's,
   * as for the board's own moves: `todos_override` moves a task out of In progress past its agent's unfinished todo list.
   */
  Rpc.make("threads.actOnSuggestion", {
    payload: { task_id: TaskId, item_id: Schema.String, index: Schema.Int, choice: SuggestionChoice, todos_override: Schema.optional(Schema.Boolean) },
    success: Schema.Void,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
).middleware(Auth) {}
