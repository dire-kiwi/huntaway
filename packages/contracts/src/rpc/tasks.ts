import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { TaskSkills } from "../agentTools.ts"
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
  /**
   * 4.6: review the task's work now (the old `POST /tasks/{id}/review`), even if the project doesn't review by itself or
   * this commit was reviewed; it starts a fresh cycle of fixes. A task in In progress or Needs attention moves to In
   * review. `Conflict` says why it can't ("Can't review: …").
   */
  Rpc.make("tasks.review", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /**
   * 4.6: give a task whose review still found issues after its rounds of fixes as many more (at least one): its agent is
   * sent the issues again (the old `POST /tasks/{id}/review/extend`).
   */
  Rpc.make("tasks.extendReview", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** 4.6: summarise the task's changes now, whatever its review and column (the old `POST /tasks/{id}/summary`). */
  Rpc.make("tasks.summarize", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** How full the task's agent's context is: the summary on the task and the latest breakdown (the old `GET /tasks/{id}/context`). */
  Rpc.make("tasks.context", {
    payload: { id: TaskId },
    success: Schema.Struct({ context: Schema.NullOr(TaskContext), detail: Schema.Unknown }),
    error: NotFound,
  }).annotate(RequiredScope, "read"),
  /**
   * Fix broken checks (the old `POST /tasks/{id}/fix_checks`): read the task's pull request now and send its agent the
   * head commit's failed checks with the ends of their logs. `Invalid` (`pr_url`) without a readable pull request,
   * `Conflict` (`pr_not_open`, `nothing_failed`) when there's nothing to fix; a refused message as `tasks.send`. The task.
   */
  Rpc.make("tasks.fixChecks", { payload: { id: TaskId }, success: Task, error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /**
   * 4.8: where the open tasks merging into (or stacked on) the same closed or deleted task as this one go now, all of them
   * at once (the old `POST /tasks/{id}/merge-target`): `onward` (where that one was going), `close` (done as that one
   * ended), or one of them by id (it takes that one's place). The tasks changed. `Conflict` when there's nothing to choose
   * or one's agent is running; `Invalid` (`to`) for a task that isn't one of them.
   */
  Rpc.make("tasks.mergeTarget", {
    payload: { id: TaskId, to: Schema.String },
    success: Schema.Array(Task),
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "operate"),
  /**
   * 4.8: merge the whole stack the task is in as one run (the old `POST /tasks/{id}/merge-stack`): every open level of its
   * main line moves to Ready for merge, bottom first, and they merge with nothing else between them. The levels, bottom
   * first. `Conflict` says why it can't yet ("The stack can't merge yet: …"); `Invalid` for a task in no stack.
   */
  Rpc.make("tasks.mergeStack", {
    payload: { id: TaskId },
    success: Schema.Array(Task),
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /**
   * 4.8: a stack's title and description (the old `PATCH /tasks/{id}/stack`), kept on its bottom task: set by hand (which
   * pins them), or written again by the model (`regenerate`, which unpins them). `id` is any level. The bottom task.
   */
  Rpc.make("tasks.updateStack", {
    payload: {
      id: TaskId,
      title: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      regenerate: Schema.optional(Schema.Boolean),
    },
    success: Task,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "operate"),
  /** Whether moving the task to Done would leave work of its unmerged, for the board to ask first (the old `GET /tasks/{id}/unmerged`). */
  Rpc.make("tasks.unmerged", { payload: { id: TaskId }, success: Schema.Struct({ unmerged: Schema.Boolean }), error: NotFound }).annotate(
    RequiredScope,
    "read",
  ),
  // 6.4: the skills its agent can be asked to use, for the composer's `/` menu (the old `GET /tasks/{id}/skills`).
  Rpc.make("tasks.skills", { payload: { id: TaskId }, success: TaskSkills, error: NotFound }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
