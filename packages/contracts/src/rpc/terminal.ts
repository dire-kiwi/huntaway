import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound, Unavailable } from "../errors.ts"
import { TerminalTool } from "../host.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// A task's terminals (docs/plan/06-server.md, Terminal; inventory 05, section 2.5; the old `/tasks/{id}/terminal`
// routes and wire/terminal.ts): a tmux session for the task's shell and one for each of the host's terminal tools,
// which outlive the browser and the server. `terminal.open` gives a ticket for the socket `/api/terminal/<ticket>`
// (docs/plan/05-protocol.md, Plain HTTP), which carries the terminal: binary frames its output and input, JSON text
// frames the control messages below.

/** A task's terminal on its host (the old `TerminalStatus`). */
export const TerminalStatus = Schema.Struct({
  /** False when the host can't have terminals (no tmux): `reason` says why. */
  available: Schema.Boolean,
  /** Whether the session exists (it outlives the browser and the server). */
  running: Schema.Boolean,
  /** Where it starts: the task's worktree once there is one, otherwise where its agent would work. */
  cwd: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  /** The tool this session runs, when asked for one. */
  tool: Schema.NullOr(TerminalTool),
})
export interface TerminalStatus extends Schema.Schema.Type<typeof TerminalStatus> {}

/** What opens the terminal's socket once (`/api/terminal/<ticket>?cols=&rows=`), within a minute. */
export const TerminalTicket = Schema.Struct({ ticket: Schema.String })
export interface TerminalTicket extends Schema.Schema.Type<typeof TerminalTicket> {}

/** The server's control frames: the session is attached; are you still there (answer `pong`). */
export const TerminalServerFrame = Schema.Union([Schema.Struct({ type: Schema.Literal("ready") }), Schema.Struct({ type: Schema.Literal("ping") })])
export type TerminalServerFrame = typeof TerminalServerFrame.Type

/** The client's control frames: its size changed; it has drawn `bytes` of output; it is still there. */
export const TerminalClientFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resize"), cols: Schema.Int, rows: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("ack"), bytes: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("pong") }),
])
export type TerminalClientFrame = typeof TerminalClientFrame.Type

/** The task, and the id of one of the host's terminal tools for its session rather than the task's shell. */
const Which = { task_id: TaskId, tool: Schema.optional(Schema.NullOr(Schema.String)) }

export class TerminalRpcs extends RpcGroup.make(
  /** The task's terminal (or a tool's): whether the host has terminals, whether it runs, and where it starts. */
  Rpc.make("terminal.status", { payload: Which, success: TerminalStatus, error: NotFound }).annotate(RequiredScope, "terminal"),
  /** A ticket for the terminal's socket; the session is made when the socket attaches, if it isn't there. */
  Rpc.make("terminal.open", { payload: Which, success: TerminalTicket, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "terminal"),
  /** End the task's shell session, or a tool's (one taken out of the host's settings too). */
  Rpc.make("terminal.kill", { payload: Which, error: NotFound }).annotate(RequiredScope, "terminal"),
  /** A board still has this tool's session open: it isn't ended for the next 90 seconds. */
  Rpc.make("terminal.keepalive", { payload: { task_id: TaskId, tool: Schema.String }, error: NotFound }).annotate(RequiredScope, "terminal"),
).middleware(Auth) {}
