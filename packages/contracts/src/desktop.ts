import { Schema } from "effect"
import { RunId, TaskId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// Computer use (docs/plan/inventory/05-hosts-update.md 2.8, 3.3): a host's Cua Driver, whether its agents may use its
// desktop, and what a task's agent looked at and did there. The old `GET /desktop` and its client's `DesktopStatus`.

/** Installing Cua Driver on a host: how far it has got. */
export const DesktopInstall = Schema.Struct({
  version: Schema.String,
  phase: Schema.Literals(["downloading", "verifying", "unpacking", "done", "failed"]),
  /** Bytes downloaded so far, of `total`. */
  received: Schema.Int,
  total: Schema.Int,
  error: Schema.NullOr(Schema.String),
  started_at: Timestamp,
  finished_at: Schema.NullOr(Timestamp),
})
export interface DesktopInstall extends Schema.Schema.Type<typeof DesktopInstall> {}

/** The host's one `cua-driver mcp`. */
export const DesktopDriverStatus = Schema.Struct({
  state: Schema.Literals(["stopped", "starting", "running", "failed"]),
  /** The driver's own version, from its `initialize` answer. */
  version: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Timestamp),
  last_call_at: Schema.NullOr(Timestamp),
  /** How many tools it offers. */
  tools: Schema.Int,
  /** The last lines it wrote to stderr. */
  stderr: Schema.String,
})
export interface DesktopDriverStatus extends Schema.Schema.Type<typeof DesktopDriverStatus> {}

/** Whether a host's agents may use its desktop, and its Cua Driver. */
export const DesktopStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** Node's name for the host's platform (`linux`, `darwin`). */
  platform: Schema.String,
  /** The release the host's page would install, or null where Cua has none for this platform. */
  release: Schema.NullOr(Schema.Struct({ version: Schema.String, bytes: Schema.Int })),
  /** The driver it would run: installed from its page, the server's `HUNTAWAY_CUA_DRIVER`, or one on PATH (whose version isn't known). */
  installed: Schema.NullOr(
    Schema.Struct({ path: Schema.String, source: Schema.Literals(["installed", "env", "path"]), version: Schema.NullOr(Schema.String) }),
  ),
  install: Schema.NullOr(DesktopInstall),
  driver: DesktopDriverStatus,
  /** "wayland", "x11", "macos", or null when the host has no graphical session the driver can see. */
  session: Schema.NullOr(Schema.String),
  /** Null where the host can't tell. */
  locked: Schema.NullOr(Schema.Boolean),
  /** The task driving the desktop now. */
  in_use_by: Schema.NullOr(Schema.Struct({ task_id: TaskId, title: Schema.String })),
})
export interface DesktopStatus extends Schema.Schema.Type<typeof DesktopStatus> {}

/** `desktop.check`'s answer: the status, and what the driver said it may do (or why it couldn't start). */
export const DesktopCheck = Schema.Struct({ ...DesktopStatus.fields, check: Schema.String })
export interface DesktopCheck extends Schema.Schema.Type<typeof DesktopCheck> {}

/** An image of what a task's agent looks at on the desktop. */
export const DesktopFrame = Schema.Struct({
  mime: Schema.String,
  /** Base64. */
  data: Schema.String,
  width: Schema.NullOr(Schema.Finite),
  height: Schema.NullOr(Schema.Finite),
  /** The window's (null for the whole desktop). */
  pid: Schema.NullOr(Schema.Int),
  window_id: Schema.NullOr(Schema.Int),
  at: Timestamp,
})
export interface DesktopFrame extends Schema.Schema.Type<typeof DesktopFrame> {}

/** A frame, or why there is none. */
export const DesktopFrameResult = Schema.Struct({ frame: Schema.NullOr(DesktopFrame), reason: Schema.optional(Schema.String) })
export interface DesktopFrameResult extends Schema.Schema.Type<typeof DesktopFrameResult> {}

/** `running`, then `ok` or `failed`; `interrupted` for one that was running when the server stopped. */
export const DesktopOpStatus = Schema.Literals(["running", "ok", "failed", "interrupted"])
export type DesktopOpStatus = typeof DesktopOpStatus.Type

/** Something a task's agent did on the desktop (its reads aren't kept): a `desktop_ops` row. */
export const DesktopOp = Schema.Struct({
  id: Schema.String,
  task_id: TaskId,
  run_id: Schema.NullOr(RunId),
  /** The agent's name for it, if it gave one. */
  op_id: Schema.NullOr(Schema.String),
  tool: Schema.Literals(["act", "launch", "clipboard"]),
  /** A line saying what it did, for the board. */
  summary: Schema.String,
  status: DesktopOpStatus,
  /** Its text, as the agent got it (images aren't kept). */
  result: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  finished_at: Schema.NullOr(Timestamp),
})
export interface DesktopOp extends Schema.Schema.Type<typeof DesktopOp> {}

/** The window a task's agent last looked at or acted on, which the viewer shows. */
export const DesktopTarget = Schema.Struct({ pid: Schema.Int, window_id: Schema.NullOr(Schema.Int), at: Timestamp })
export interface DesktopTarget extends Schema.Schema.Type<typeof DesktopTarget> {}

/** What a task's agent did on the desktop (newest first), and the window it last used. */
export const TaskDesktop = Schema.Struct({ ops: Schema.Array(DesktopOp), target: Schema.NullOr(DesktopTarget) })
export interface TaskDesktop extends Schema.Schema.Type<typeof TaskDesktop> {}
