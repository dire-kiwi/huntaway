import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DesktopCheck, DesktopFrameResult, DesktopStatus, TaskDesktop } from "../desktop.ts"
import { Conflict, NotFound, Unavailable } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * Computer use (the old `/desktop` routes, 51–56): the host's page installs Cua Driver and turns computer use on, and a
 * task's viewer shows what its agent looks at (`frame`) and did (`ops`). Seeing the host's screen is `terminal`;
 * installing, starting and stopping the driver and turning it on are `admin`. Each change answers with the new status.
 */
export class DesktopRpcs extends RpcGroup.make(
  Rpc.make("desktop.status", { success: DesktopStatus }).annotate(RequiredScope, "terminal"),
  /** Let this host's agents use its desktop (from their next run); off stops the driver. */
  Rpc.make("desktop.setEnabled", { payload: { enabled: Schema.Boolean }, success: DesktopStatus }).annotate(RequiredScope, "admin"),
  /** Download and install this platform's release in the background; `Unavailable` where Cua has none. */
  Rpc.make("desktop.install", { success: DesktopStatus, error: Unavailable }).annotate(RequiredScope, "admin"),
  /** Remove the installed driver (not one from `HUNTAWAY_CUA_DRIVER` or PATH); `Conflict` while one is being installed. */
  Rpc.make("desktop.uninstall", { success: DesktopStatus, error: Conflict }).annotate(RequiredScope, "admin"),
  /** Stop the driver (it starts again when an agent needs it). */
  Rpc.make("desktop.stop", { success: DesktopStatus }).annotate(RequiredScope, "admin"),
  /** Start the driver and ask it what it may do (its `check_permissions`). */
  Rpc.make("desktop.check", { success: DesktopCheck }).annotate(RequiredScope, "admin"),
  /**
   * An image of the window task `task_id`'s agent last used (or `pid` and `window_id`; the whole desktop before it has
   * used one), or why there is none. It never starts the driver and never shows a locked screen.
   */
  Rpc.make("desktop.frame", {
    payload: { task_id: Schema.optional(TaskId), pid: Schema.optional(Schema.Int), window_id: Schema.optional(Schema.Int) },
    success: DesktopFrameResult,
  }).annotate(RequiredScope, "terminal"),
  /** What a task's agent did on the desktop, newest first, and the window it last used. */
  Rpc.make("desktop.ops", { payload: { task_id: TaskId }, success: TaskDesktop, error: NotFound }).annotate(RequiredScope, "terminal"),
).middleware(Auth) {}
