import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DirListing } from "../dirs.ts"
import { Invalid } from "../errors.ts"
import { HostInfo, HostSettings, HostSettingsPatch } from "../host.ts"
import { DefaultPrompts } from "../project.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Usage } from "../usage.ts"

/** This host about itself (docs/plan/05-protocol.md, `host`). */
export class HostRpcGroup extends RpcGroup.make(
  Rpc.make("host.info", { success: HostInfo }).annotate(RequiredScope, "read"),
  Rpc.make("host.settings", { success: HostSettings }).annotate(RequiredScope, "read"),
  /** Emits `settings_changed`. */
  Rpc.make("host.updateSettings", { payload: { patch: HostSettingsPatch }, success: HostSettings, error: Invalid }).annotate(RequiredScope, "settings"),
  /** The folder browser: `path` absent or blank is the home folder; `~` is expanded. */
  /** Each config's usage limits, as last read (`refresh`: read again now) (the old `GET /api/usage`). */
  Rpc.make("host.usage", { payload: { refresh: Schema.optional(Schema.Boolean) }, success: Schema.Array(Usage) }).annotate(RequiredScope, "read"),
  Rpc.make("host.listDirs", { payload: { path: Schema.optional(Schema.String) }, success: DirListing, error: Invalid }).annotate(RequiredScope, "admin"),
  /** The start, review and merge instructions a project without its own uses (the old `GET /default-prompts`). 6.12. */
  Rpc.make("host.defaultPrompts", { success: DefaultPrompts }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
