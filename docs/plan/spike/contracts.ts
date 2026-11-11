import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const Status = Schema.Literals(["todo", "in_progress", "done"])
export type Status = typeof Status.Type

export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  title: Schema.String,
  status: Status,
  createdAt: Schema.DateTimeUtcFromMillis
}) {}

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", { id: TaskId }) {}
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export const BoardEvent = Schema.Union([
  Schema.TaggedStruct("TaskUpserted", { seq: Schema.Int, task: Task }),
  Schema.TaggedStruct("TaskDeleted", { seq: Schema.Int, id: TaskId })
])
export type BoardEvent = typeof BoardEvent.Type

export class Session extends Context.Service<Session, { readonly device: string }>()("huntaway/Session") {}

export class Auth extends RpcMiddleware.Service<Auth, { provides: Session }>()("huntaway/Auth", {
  error: Unauthorized,
  requiredForClient: true
}) {}

export class BoardRpcs extends RpcGroup.make(
  Rpc.make("tasks.get", { payload: { id: TaskId }, success: Task, error: TaskNotFound }),
  Rpc.make("tasks.create", { payload: { title: Schema.String }, success: Task }),
  Rpc.make("tasks.setStatus", { payload: { id: TaskId, status: Status }, success: Task, error: TaskNotFound }),
  Rpc.make("board.subscribe", { payload: { since: Schema.optional(Schema.Int) }, success: BoardEvent, stream: true })
).middleware(Auth) {}
