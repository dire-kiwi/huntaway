import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, Unavailable } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { ServerStatus, UpdateRequest, UpdateResult } from "../update.ts"

/**
 * Restarting and updating this host (docs/plan/05-protocol.md, `admin`; the old `/admin/*` routes). A job that restarts
 * runs in the background: the call returns once it has started, and its progress comes as `restart` and `restart_log`
 * events. A second job while one runs is `Conflict` (`restart_in_progress`). A host that cannot do what is asked here
 * (no checkout, a dirty one, no release updates) says so with `Unavailable`; a payload that is wrong, with `Invalid`.
 * `admin.status` and `admin.update` are the stable core: their shapes only grow.
 */
export class AdminRpcs extends RpcGroup.make(
  Rpc.make("admin.status", { success: ServerStatus }).annotate(RequiredScope, "admin"),
  /** Restart in place (the same process), with `rebuild` after rebuilding the UI and the shim from the source checkout. */
  Rpc.make("admin.restart", { payload: { rebuild: Schema.optional(Schema.Boolean) }, error: Schema.Union([Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "admin",
  ),
  /** A hub's Update: to its code (a bundle, or a commit from this host's origin), or to the release it runs. */
  Rpc.make("admin.update", { payload: UpdateRequest, success: UpdateResult, error: Schema.Union([Conflict, Invalid, Unavailable]) }).annotate(
    RequiredScope,
    "admin",
  ),
  /** Check GitHub for releases now; the status after it. */
  Rpc.make("admin.checkRelease", { success: ServerStatus, error: Unavailable }).annotate(RequiredScope, "admin"),
  /** Restart onto a release: at once if it is staged, else once it is downloaded and checked. */
  Rpc.make("admin.updateRelease", { payload: { version: Schema.String }, error: Schema.Union([Conflict, Invalid, Unavailable]) }).annotate(
    RequiredScope,
    "admin",
  ),
  /** Mark the running release bad and restart onto the one before it (or the server the host was installed as). */
  Rpc.make("admin.rollback", { error: Schema.Union([Conflict, Unavailable]) }).annotate(RequiredScope, "admin"),
  /** Install this server as a systemd user service and hand over to it. */
  Rpc.make("admin.installService", { error: Schema.Union([Conflict, Unavailable]) }).annotate(RequiredScope, "admin"),
).middleware(Auth) {}
