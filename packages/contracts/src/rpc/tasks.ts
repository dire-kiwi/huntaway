import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Context as TaskContext, NewTask, Task, TaskFilter, TaskPatch } from "../task.ts"

/** Tasks (the old `/projects/{id}/tasks`, `/profiles/{id}/tasks`, `/tasks/{id}`). Changes emit `task` or `task_deleted`. */
export class TaskRpcs extends RpcGroup.make(
  Rpc.make("tasks.list", { payload: { filter: TaskFilter }, success: Schema.Array(Task), error: NotFound }).annotate(RequiredScope, "read"),
  /** By id, key (`HE-2`), former key or `<profile>:<key>`. */
  Rpc.make("tasks.get", { payload: { id: Schema.String }, success: Task, error: NotFound }).annotate(RequiredScope, "read"),
  /** With `start`, its agent starts (the errors of `tasks.send` then); with only a description, once its title is written. */
  Rpc.make("tasks.create", { payload: { task: NewTask }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]) }).annotate(
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
  /** Stop a server the task's processes left listening on `port` (the old `POST /tasks/{id}/servers/{port}/stop`). */
  Rpc.make("tasks.stopServer", {
    payload: { id: TaskId, port: Schema.Int },
    success: Task,
    error: Schema.Union([NotFound, Conflict, Invalid]),
  }).annotate(RequiredScope, "operate"),
  /**
   * Stop the agent's background shells, or just `background_id`, leaving the agent be (the banner's Stop; the old
   * `POST /tasks/{id}/background/stop`): the ids it asked Claude Code to stop.
   */
  Rpc.make("tasks.stopBackground", {
    payload: { id: TaskId, background_id: Schema.optional(Schema.String) },
    success: Schema.Struct({ stopping: Schema.Array(Schema.String) }),
    error: Schema.Union([NotFound, Conflict]),
  }).annotate(RequiredScope, "operate"),
  /** "Carry on then": a task whose agent ran out of usage waits in In progress for the reset (the old `POST /tasks/{id}/wait-for-limit`). */
  Rpc.make("tasks.waitForLimit", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Conflict, Invalid]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** How full the task's agent's context is: the summary on the task and the latest breakdown (the old `GET /tasks/{id}/context`). */
  Rpc.make("tasks.context", {
    payload: { id: TaskId },
    success: Schema.Struct({ context: Schema.NullOr(TaskContext), detail: Schema.Unknown }),
    error: NotFound,
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
