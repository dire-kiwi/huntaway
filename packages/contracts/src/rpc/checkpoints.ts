import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { RunId, TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Rewind, Task } from "../task.ts"
import { Timestamp } from "../time.ts"

// Checkpoints of a task's worktree (docs/plan/06-server.md, Git; inventory 04, section 2.9; the old `/tasks/{id}/turns`
// and `/tasks/{id}/rewind`): what each of its agent's turns changed, the changes between two checkpoints, and rewinding
// the task to before one of its messages. A message is named by its thread write number (`legacy:<n>`), which the old
// API called its message id. A turn checkpoint or a rewind emits `checkpoints` on the board.

/** What a turn changed, without the files git brought in (a merge, pull or rebase). */
export const TurnStats = Schema.Struct({
  files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  /** The files git brought in that are left out (the first 200), and how many there are. */
  excluded: Schema.Array(Schema.String),
  excluded_count: Schema.Int,
})
export interface TurnStats extends Schema.Schema.Type<typeof TurnStats> {}

/** What a rewind to before a turn can do to the agent's conversation: go back (`fresh`: start over), or why it can't. */
export const TurnConversation = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), fresh: Schema.Boolean }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
])
export type TurnConversation = typeof TurnConversation.Type

/** Whether the task can be rewound to before a turn (and its conversation with it), or why not. */
export const TurnRewind = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), conversation: TurnConversation }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
])
export type TurnRewind = typeof TurnRewind.Type

/** One of the agent's turns with a checkpoint. */
export const Turn = Schema.Struct({
  /** Its number among the task's turns. */
  turn: Schema.Int,
  /** Its checkpoint, and the one it started from (null when that is gone). */
  n: Schema.Int,
  before_n: Schema.NullOr(Schema.Int),
  run_id: Schema.NullOr(RunId),
  /** The message it started with (its write number); null for a turn the agent started by itself. */
  message_id: Schema.NullOr(Schema.Int),
  /** The message's text (up to 300 characters), "" when not known. */
  text: Schema.String,
  /** The board sent the message itself. */
  auto: Schema.Boolean,
  /** The message asked to fix a review round's issues. */
  review_round: Schema.NullOr(Schema.Int),
  status: Schema.NullOr(Schema.Literals(["done", "stopped", "failed"])),
  /** A rewind has gone back to before it. */
  stale: Schema.Boolean,
  at: Timestamp,
  /** The worktree's HEAD after it, and before it. */
  head: Schema.NullOr(Schema.String),
  before_head: Schema.NullOr(Schema.String),
  stats: Schema.NullOr(TurnStats),
  /** Its changes can be shown (`checkpoints.turnDiff` from `before_n` to `n`). */
  diff: Schema.Boolean,
  rewind: TurnRewind,
})
export interface Turn extends Schema.Schema.Type<typeof Turn> {}

/** A task's turns, oldest first, or why it has none (no worktree of its own). */
export const Turns = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(true),
    turns: Schema.Array(Turn),
    /** The worktree's HEAD now. */
    head: Schema.NullOr(Schema.String),
    /** The conversation rollback its next run makes. */
    rewind: Schema.NullOr(Rewind),
    agent: Schema.Literals(["claude", "codex"]),
  }),
  Schema.Struct({ available: Schema.Literal(false), reason: Schema.String, turns: Schema.Array(Turn), rewind: Schema.NullOr(Rewind) }),
])
export type Turns = typeof Turns.Type

/** The changes between two checkpoints, without the files git brought in. Past 4 MiB the patch is not sent (`too_large`). */
export const TurnDiff = Schema.Struct({
  patch: Schema.String,
  too_large: Schema.Boolean,
  stats: TurnStats,
  excluded: Schema.Array(Schema.String),
})
export interface TurnDiff extends Schema.Schema.Type<typeof TurnDiff> {}

/** What a rewind did. */
export const RewindResult = Schema.Struct({
  /** The message rewound to, for the composer to edit and send again. */
  message: Schema.Struct({ text: Schema.NullOr(Schema.String), auto: Schema.Boolean }),
  task: Schema.NullOr(Task),
  written: Schema.Int,
  removed: Schema.Int,
  /** Left as they were: submodules and other repositories, hidden files and files the checkpoints don't have. */
  skipped: Schema.Array(Schema.String),
  /** The branch moved back: from the commit it was at to the one it is at now. */
  branch: Schema.NullOr(Schema.Struct({ from: Schema.String, to: Schema.String })),
  /** The ref that keeps the files as they were before the rewind. */
  kept: Schema.String,
})
export interface RewindResult extends Schema.Schema.Type<typeof RewindResult> {}

export class CheckpointRpcs extends RpcGroup.make(
  /** A task's turns with checkpoints, what each changed and whether it can be rewound to (the old `GET /tasks/{id}/turns`). */
  Rpc.make("checkpoints.turns", { payload: { task_id: TaskId }, success: Turns, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "read"),
  /** The changes from checkpoint `from` to `to`: a turn's, or several turns' together (`GET /tasks/{id}/turns/diff`). */
  Rpc.make("checkpoints.turnDiff", {
    payload: { task_id: TaskId, from: Schema.Int, to: Schema.Int },
    success: TurnDiff,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "read"),
  /**
   * Restore the task's files to how they were before the turn message `message_id` started; with `branch`, move its
   * branch back too, and with `conversation`, have its agent's next run take the conversation back (`POST
   * /tasks/{id}/rewind`). Refused while its agent or a review of it runs.
   */
  Rpc.make("checkpoints.rewind", {
    payload: { task_id: TaskId, message_id: Schema.Int, conversation: Schema.optional(Schema.Boolean), branch: Schema.optional(Schema.Boolean) },
    success: RewindResult,
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "git"),
  /** The agent's next run keeps its conversation as it is (`DELETE /tasks/{id}/rewind`): the task after. */
  Rpc.make("checkpoints.cancelRewind", { payload: { task_id: TaskId }, success: Task, error: NotFound }).annotate(RequiredScope, "git"),
).middleware(Auth) {}
