import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { NewTask, Task, TaskFilter, TaskPatch } from "../task.ts"

/** Tasks (the old `/projects/{id}/tasks`, `/profiles/{id}/tasks`, `/tasks/{id}`). Changes emit `task` or `task_deleted`. */
export class TaskRpcs extends RpcGroup.make(
  Rpc.make("tasks.list", { payload: { filter: TaskFilter }, success: Schema.Array(Task), error: NotFound }).annotate(RequiredScope, "read"),
  /** By id, key (`HE-2`), former key or `<profile>:<key>`. */
  Rpc.make("tasks.get", { payload: { id: Schema.String }, success: Task, error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("tasks.create", { payload: { task: NewTask }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "operate",
  ),
  Rpc.make("tasks.update", { payload: { id: TaskId, patch: TaskPatch }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** `delete_branch`: also delete its branch (once worktrees exist, M4). */
  Rpc.make("tasks.delete", { payload: { id: TaskId, delete_branch: Schema.optional(Schema.Boolean) }, error: Schema.Union([NotFound, Conflict]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /**
   * A message for the task's thread (the old `POST /tasks/{id}/messages`): steered into its live run, queued, held for
   * its dependencies or usage, or it starts a run. `/new`, `/compact` and `/plan` are the board's. The task as it is after.
   */
  Rpc.make("tasks.send", {
    payload: { id: TaskId, text: Schema.String },
    success: Task,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /** Stop the task's run, and its review, summary and workflow-step runs (the old `POST /tasks/{id}/stop`). */
  Rpc.make("tasks.stop", { payload: { id: TaskId }, success: Schema.Struct({ stopped: Schema.Boolean }), error: NotFound }).annotate(RequiredScope, "operate"),
  /** Take back what is queued for the next run: the task as it was, so the client can put the text back in the composer. */
  Rpc.make("tasks.dropQueued", { payload: { id: TaskId }, success: Task, error: NotFound }).annotate(RequiredScope, "operate"),
).middleware(Auth) {}
