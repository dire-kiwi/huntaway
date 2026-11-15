import { Context } from "effect"
import type { Effect, Option, Redacted } from "effect"
import type { PluginProfile, PluginProject, PluginTask } from "./context.ts"
import type { PluginError } from "./errors.ts"

// The board's services a plugin may call (docs/plan/15-plugins.md), given to its `make` and its handlers. One per
// plugin: what it reads and writes is the board's, as the plugin's own (its events are tagged with its id, its secrets
// are its own).

/**
 * Something for the web UI: the plugin's frames get it (`huntaway.onEvent`), on every page of the board that shows one
 * of them. `reload` also renders the plugin's pages again (their frames are reloaded); without it, a frame's own
 * script decides what to do. Events are hints that something changed, not a log: a frame may miss one (it wasn't open)
 * or get only the latest of a burst.
 */
export interface PluginEvent {
  /** What changed, in the plugin's own words (`comments`, `documents`…). */
  readonly topic: string
  /** The profile it is about, if any. */
  readonly profile_id?: string | null | undefined
  /** Any JSON. Small: it goes to every board client. */
  readonly data?: unknown
  readonly reload?: boolean | undefined
}

/** Values the plugin keeps that are never shown or logged (a profile's tokens for an outside service). */
export interface PluginSecrets {
  /** `profile` null: the plugin's own, for no profile. */
  readonly get: (profile: string | null, name: string) => Effect.Effect<Option.Option<Redacted.Redacted>>
  readonly set: (profile: string | null, name: string, value: string | Redacted.Redacted) => Effect.Effect<void>
  readonly remove: (profile: string | null, name: string) => Effect.Effect<void>
}

export interface PluginHostShape {
  /** The plugin's id. */
  readonly plugin: string
  /** This host's id and name: a plugin's data is per host, as the board's is. */
  readonly hostId: string
  readonly hostName: string
  /** A folder of the plugin's own in the board's data folder, for files (images, caches). Private (0700). */
  readonly filesDir: string
  /** The board's address for links people open: its Public URL setting, else its own on this machine. No trailing `/`. */
  readonly boardUrl: Effect.Effect<string>
  /** The address of one of the plugin's pages, `path` under `/<plugin id>/`: stable, for links agents hand out. */
  readonly pageUrl: (path: string) => Effect.Effect<string>
  readonly profiles: Effect.Effect<ReadonlyArray<PluginProfile>>
  readonly profile: (id: string) => Effect.Effect<PluginProfile | null>
  /** A task by its id or its key (`HE-34`); null when this host has none. */
  readonly task: (idOrKey: string) => Effect.Effect<PluginTask | null>
  readonly project: (id: string) => Effect.Effect<PluginProject | null>
  /**
   * A message to a task's agent, as the board sends one (it steers a run that's working, queues behind one, or starts
   * one). `not_found` when the task is gone; `conflict` or `unavailable` when the board won't send it now (the task is
   * archived or merging, the host runs no agents), with why.
   */
  readonly sendToTask: (task: string, text: string) => Effect.Effect<void, PluginError>
  /** Tells the web UI (see `PluginEvent`). */
  readonly emit: (event: PluginEvent) => Effect.Effect<void>
  readonly secrets: PluginSecrets
}

/** The board's services, for the plugin that is being built or called. */
export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()("@huntaway/plugin/PluginHost") {}

/**
 * The board's existing tables a plugin may copy when it first runs, in its migrations: what a feature the board had
 * built in kept, so moving it into a plugin loses nothing. Only the tables the board lists for the plugin's id.
 */
export interface PluginImportShape {
  /** The tables this plugin may read. */
  readonly tables: ReadonlyArray<string>
  /** Every row of one of them, as SQLite gives it (`not_found` for a table not listed, or not there). */
  readonly rows: (table: string) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, PluginError>
}

export class PluginImport extends Context.Service<PluginImport, PluginImportShape>()("@huntaway/plugin/PluginHost/PluginImport") {}
