import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound } from "../errors.ts"
import { TaskId } from "../ids.ts"
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
).middleware(Auth) {}
