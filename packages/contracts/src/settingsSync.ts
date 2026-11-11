import { Schema } from "effect"
import { HostId } from "./ids.ts"

// Settings sync between hosts (docs/plan/08-hosts.md, Discovery, SSH, settings sync; inventory 05 §2.7, §9): the
// settings that mean the same on every host, each under a name that does not depend on the host, with a version vector.
// Capability `settings_sync`. The structure is checked here; the limits (how many entries, how long a value, what a time
// looks like) by the host that takes them.

/** A value of a synced setting that lost to a change made on another host while the two were apart. */
export const SyncLost = Schema.Struct({
  value: Schema.Unknown,
  /** The host that set it (its id), and when by that host's clock ("" for the value it had before it synced). */
  by: Schema.String,
  at: Schema.String,
  /** For a value from before its host synced: when that host began to sync (the earlier of two such wins). */
  since: Schema.optional(Schema.String),
})
export interface SyncLost extends Schema.Schema.Type<typeof SyncLost> {}

/** A synced setting as a host has it. */
export const SyncEntry = Schema.Struct({
  /** Its name on every host: `global/<setting>`, or `profile/<the profile's name, URI-encoded>/<field>`. */
  name: Schema.String,
  value: Schema.Unknown,
  /** Its version vector: how many times each host (by id) has changed it, as far as this entry has heard. */
  vv: Schema.Record(Schema.String, Schema.Int),
  /** When it was last changed, by the clock of the host that did ("" for a value from before that host synced), and that host's id. */
  changed_at: Schema.String,
  changed_by: Schema.String,
  /** For a value from before its host synced (`changed_at` ""): when that host began to sync. "" otherwise. */
  since: Schema.String,
  /** The values it lost to, latest first: there until one is picked, or the setting changes again. */
  lost: Schema.Array(SyncLost),
})
export interface SyncEntry extends Schema.Schema.Type<typeof SyncEntry> {}

/** `settingsSync.get`: whether this host syncs its settings, and its entries (none while it is off). */
export const SettingsSyncStatus = Schema.Struct({
  enabled: Schema.Boolean,
  host_id: HostId,
  entries: Schema.Array(SyncEntry),
})
export interface SettingsSyncStatus extends Schema.Schema.Type<typeof SettingsSyncStatus> {}
