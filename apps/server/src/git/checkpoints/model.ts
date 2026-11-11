import { Schema } from "effect"
import { RunId, Timestamp, TurnStats } from "@huntaway/contracts"
import { NullableJsonColumn } from "../../platform/columns.ts"

// What checkpoints are made of (docs/plan/06-server.md, Git; inventory 04, sections 2.9 and 3.3; huntaway's
// git/checkpoints.ts): the `checkpoints` row, the limits, the refs, and the errors the service adds. Plain values; the
// git work is in the other files of this folder and the service in `../Checkpoints.ts`.

/** Checkpoints a task keeps; the oldest go first. */
export const MAX_CHECKPOINTS = 200
/** Untracked files bigger than this are left out of checkpoints. */
export const MAX_UNTRACKED_FILE = 50 * 1024 * 1024
/** With more untracked files than this (a folder that should be ignored, say), no checkpoint is taken. */
export const MAX_UNTRACKED = 20_000
/** Commits a turn can bring in before its changes are shown without leaving any out. */
export const MAX_COMMITS = 5000
/** Past this a diff isn't sent. */
export const MAX_DIFF = 4 * 1024 * 1024

export const refPrefix = (task: string): string => `refs/huntaway/checkpoints/${task}/`
export const refName = (task: string, n: number): string => `${refPrefix(task)}${n}`

/** start (before a run), turn (after one of the agent's turns) or rewind (the files a rewind replaced). */
export const CheckpointKind = Schema.Literals(["start", "turn", "rewind"])
export type CheckpointKind = typeof CheckpointKind.Type

/** How a turn ended. */
export const TurnStatus = Schema.Literals(["done", "stopped", "failed"])
export type TurnStatus = typeof TurnStatus.Type

/** A checkpoint, as `checkpoints` keeps it. */
export const Checkpoint = Schema.Struct({
  n: Schema.Int,
  kind: CheckpointKind,
  sha: Schema.String,
  tree: Schema.String,
  /** The worktree's HEAD then (null before its first commit). */
  head: Schema.NullOr(Schema.String),
  /** A turn's: the checkpoint it started from. */
  before_n: Schema.NullOr(Schema.Int),
  run_id: Schema.NullOr(RunId),
  /** A turn's number among the task's. */
  turn: Schema.NullOr(Schema.Int),
  /** A turn's: the thread write of the message it started with (the old `message_id`). */
  write_no: Schema.NullOr(Schema.Int),
  /** A turn's: done, stopped or failed. */
  status: Schema.NullOr(TurnStatus),
  /** The agent's session (Claude) or thread (Codex) then. */
  session: Schema.NullOr(Schema.String),
  /** A turn's place in the agent's conversation: Claude's last message in it, Codex's id for the turn. */
  agent_at: Schema.NullOr(Schema.String),
  stats: NullableJsonColumn(TurnStats),
  /** 0, 1 once a rewind has gone back to before it, 2 when that took the conversation back too. */
  stale: Schema.Int,
  created_at: Timestamp,
})
export interface Checkpoint extends Schema.Schema.Type<typeof Checkpoint> {}

/** A snapshot of a worktree's files: the commit, its tree and the HEAD it was taken on. */
export interface Snap {
  readonly sha: string
  readonly tree: string
  readonly head: string | null
}

/** Taking or reading a checkpoint failed: a git command, the file system, or the worktree's state (`reason`). */
export class CheckpointFailed extends Schema.TaggedError<CheckpointFailed, { readonly brand: unique symbol }>()("CheckpointFailed", {
  reason: Schema.String,
}) {}

/** A rewind (or a diff) the task's state refuses: `reason` is what the client keys on (the wire `Conflict`'s). */
export class RewindRefused extends Schema.TaggedError<RewindRefused, { readonly brand: unique symbol }>()("RewindRefused", {
  reason: Schema.Literals(["agent_running", "in_use", "changed_meanwhile"]),
  detail: Schema.String,
}) {}

/** A request that names what the task doesn't have to rewind or show (the wire `Invalid`). */
export class CheckpointInvalid extends Schema.TaggedError<CheckpointInvalid, { readonly brand: unique symbol }>()("CheckpointInvalid", {
  field: Schema.String,
  reason: Schema.String,
}) {}

/** No such checkpoint (the wire `NotFound`). */
export class CheckpointNotFound extends Schema.TaggedError<CheckpointNotFound, { readonly brand: unique symbol }>()("CheckpointNotFound", {
  n: Schema.Int,
}) {}
