import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Forbidden, NotFound } from "../errors.ts"
import { PluginFailed, PluginId, PluginInfo, PluginPage, PluginPageRequest } from "../plugin.ts"
import { Auth, RequiredScope } from "../session.ts"

// HE-34: a host's plugins (docs/plan/15-plugins.md): which it has, their pages, and what their pages call. A plugin's
// events come on the board's stream (`plugin`). Each is asked of the host whose plugin it is, as every RPC is.

export class PluginRpcs extends RpcGroup.make(
  /** The host's plugins, in the order it was built with them. */
  Rpc.make("plugins.list", { success: Schema.Array(PluginInfo) }).annotate(RequiredScope, "read"),
  /** One of a plugin's pages, rendered for this session. `NotFound` for a plugin the host hasn't, or one without pages. */
  Rpc.make("plugins.page", { payload: PluginPageRequest, success: PluginPage, error: Schema.Union([NotFound, PluginFailed]) }).annotate(RequiredScope, "read"),
  /**
   * A call of a plugin's page (`huntaway.call`): the method's payload and result are the plugin's, as JSON. The method
   * states the scope it needs (`Forbidden` when the session hasn't it); the RPC needs `read`.
   */
  Rpc.make("plugins.call", {
    payload: { plugin: PluginId, method: Schema.String, payload: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Union([NotFound, Forbidden, PluginFailed]),
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
