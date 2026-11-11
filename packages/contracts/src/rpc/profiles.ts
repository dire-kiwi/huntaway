import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AgentConfig, AgentConfigPatch, AgentModel, NewAgentConfig } from "../agentConfig.ts"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { AgentConfigId, ProfileId } from "../ids.ts"
import { NewProfile, Profile, ProfilePatch } from "../profile.ts"
import { Auth, RequiredScope } from "../session.ts"

/** Profiles (the old `/profiles`). Each change emits `profiles_changed`. */
export class ProfileRpcs extends RpcGroup.make(
  Rpc.make("profiles.list", { success: Schema.Array(Profile) }).annotate(RequiredScope, "read"),
  Rpc.make("profiles.create", { payload: { profile: NewProfile }, success: Profile, error: Schema.Union([Invalid, Conflict]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("profiles.update", {
    payload: { id: ProfileId, patch: ProfilePatch },
    success: Profile,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  /** Deletes the profile and everything that hangs off it, by hand, in order (the old `delete_profile`). */
  Rpc.make("profiles.delete", { payload: { id: ProfileId }, error: Schema.Union([NotFound, Conflict]) }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}

/** Agent configs (the old `/claude-configs`), without archives (M6). Each change emits `profiles_changed`. */
export class ConfigRpcs extends RpcGroup.make(
  Rpc.make("configs.list", { success: Schema.Array(AgentConfig) }).annotate(RequiredScope, "read"),
  Rpc.make("configs.create", { payload: { config: NewAgentConfig }, success: AgentConfig, error: Schema.Union([Invalid, Conflict]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("configs.update", {
    payload: { id: AgentConfigId, patch: AgentConfigPatch },
    success: AgentConfig,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("configs.delete", { payload: { id: AgentConfigId }, error: Schema.Union([NotFound, Conflict]) }).annotate(RequiredScope, "settings"),
  /**
   * The models a Codex config offers, with their efforts (the old `GET /claude-configs/{id}/models`): asked of Codex, and
   * kept for 10 minutes. A Claude config lists none (the UI offers Claude's aliases). `Unavailable` when Codex can't be asked.
   */
  Rpc.make("configs.models", {
    payload: { id: AgentConfigId },
    success: Schema.Array(AgentModel),
    error: Schema.Union([NotFound, Unavailable]),
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
