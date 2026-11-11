import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { AgentConfigId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// 6.11: a config's login and settings as one host hands them to another (docs/plan/inventory/02-agent-support.md §2.1,
// the old `GET/POST /claude-configs/{id}/archive`). Plain calls on one host: copying between hosts (7.5) exports on one
// and imports on the other.

/** A config's files as a gzipped tar in base64, what's in it and its size. */
export const ConfigArchive = Schema.Struct({
  archive: Schema.String,
  /** The entries it has, of the fixed list for its agent (history, caches and sessions stay behind). */
  files: Schema.Array(Schema.String),
  /** The tar's size before base64. */
  bytes: Schema.Int,
})
export interface ConfigArchive extends Schema.Schema.Type<typeof ConfigArchive> {}

export class ConfigArchiveRpcs extends RpcGroup.make(
  /**
   * The config's login, settings, skills and the like (`Invalid` `config_dir` when it has none of them). Bounded by the
   * RPC's 16 MiB message (base64: about 12 MiB of archive).
   */
  Rpc.make("configs.exportArchive", {
    payload: { id: AgentConfigId },
    success: ConfigArchive,
    error: Schema.Union([NotFound, Invalid, Unavailable]),
  }).annotate(RequiredScope, "admin"),
  /**
   * Unpacks an archive into the config's folder (made 0700 if missing). `Conflict` (`in_use`) when the folder has a
   * login already and `overwrite` isn't set; `Invalid` (`archive`) for one that isn't base64 or that tar refuses.
   */
  Rpc.make("configs.importArchive", {
    payload: { id: AgentConfigId, archive: Schema.String, overwrite: Schema.optional(Schema.Boolean) },
    success: Schema.Struct({ dir: Schema.String }),
    error: Schema.Union([NotFound, Invalid, Conflict, Unavailable]),
  }).annotate(RequiredScope, "admin"),
).middleware(Auth) {}
