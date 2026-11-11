import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid, Unavailable } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { SettingsSyncStatus, SyncEntry } from "../settingsSync.ts"

/**
 * Settings sync (the old `/settings-sync`, docs/plan/05-protocol.md): a host's entries, merging another host's into
 * them (what a hub does), and settling a setting two hosts changed apart. Switched on and off with the host's
 * `settings_sync` setting (`host.updateSettings`). Merging and resolving fail `Unavailable` while sync is off on this host (the old 409).
 */
export class SettingsSyncRpcs extends RpcGroup.make(
  Rpc.make("settingsSync.get", { success: SettingsSyncStatus }).annotate(RequiredScope, "settings"),
  /** Merges another host's entries into this host's and applies what changed: how many entries changed. */
  Rpc.make("settingsSync.merge", {
    payload: { entries: Schema.Array(SyncEntry) },
    success: Schema.Struct({ merged: Schema.Int }),
    error: Schema.Union([Unavailable, Invalid]),
  }).annotate(RequiredScope, "settings"),
  /**
   * `value` (one that lost, or any other) becomes the setting's value, or with none the value that won stays; either way
   * a change made here, which the other hosts take. A value this host cannot take, or a name it has no entry for, is
   * `Invalid`.
   */
  Rpc.make("settingsSync.resolve", {
    payload: { name: Schema.String, value: Schema.optional(Schema.Unknown) },
    success: SettingsSyncStatus,
    error: Schema.Union([Unavailable, Invalid]),
  }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}
