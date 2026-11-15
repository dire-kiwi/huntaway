import type { Effect, FileSystem, Path, Scope } from "effect"
import type { HttpClient } from "effect/http"
import type { SqlClient, SqlError } from "effect/sql"
import type { PluginCall, PluginRoute } from "./calls.ts"
import type { PluginError } from "./errors.ts"
import type { PluginPages } from "./pages.ts"
import type { PluginHost, PluginImport } from "./PluginHost.ts"
import type { PluginMcp } from "./tools.ts"

// A plugin (docs/plan/15-plugins.md): a package the server is built with, which adds an MCP server for agents, pages
// and routes, over a SQLite database of its own. It runs in the server's process, on the server's `effect` (a peer
// dependency), so its services and the board's are the same kind of thing.

/**
 * A change to the plugin's database, by name, applied once in the order given: each in a transaction with its record
 * in the database's own `migrations` table. Once released, a migration is never edited, renamed or removed. It may
 * copy the board's tables listed for the plugin (`PluginImport`).
 */
export interface PluginMigration {
  readonly name: string
  readonly run: Effect.Effect<void, SqlError.SqlError | PluginError, SqlClient.SqlClient | PluginImport>
}

/** What the plugin adds to the board, each part optional. */
export interface PluginParts {
  readonly mcp?: PluginMcp | undefined
  readonly pages?: PluginPages | undefined
  /** By method name: what the plugin's pages call (`huntaway.call`). */
  readonly calls?: Readonly<Record<string, PluginCall>> | undefined
  readonly routes?: ReadonlyArray<PluginRoute> | undefined
}

/**
 * What a plugin's `make` (and so its handlers) may use: its own database (`SqlClient`), the board's services
 * (`PluginHost`), outbound HTTP (`HttpClient`), files (its `filesDir`), and the server's scope for background fibers
 * (`Effect.forkScoped`), which ends when the server stops.
 */
export type PluginServices = SqlClient.SqlClient | PluginHost | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Scope.Scope

export interface Plugin {
  /**
   * `[a-z][a-z0-9_]*`, at most 32 characters: its MCP server's name (`mcp__<id>__<tool>`), its pages' path
   * (`/<id>/…`), its routes' (`/plugins/<id>/…`), its data folder's name. Never changed once released: links and
   * approval rules name it. Not one of the board's own names (`RESERVED_IDS`).
   */
  readonly id: string
  /** As people see it. */
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly migrations?: ReadonlyArray<PluginMigration> | undefined
  /**
   * Built once as the server starts, after its migrations, with its services. A plugin that fails here (or in a
   * migration) is listed with its error and given nothing; the board carries on without it.
   */
  readonly make: Effect.Effect<PluginParts, PluginError | SqlError.SqlError, PluginServices>
}

/** A plugin: its definition, checked by the type checker (`id` is checked when the server loads it). */
export const definePlugin = (plugin: Plugin): Plugin => plugin

/**
 * Names a plugin can't take: the board's own MCP servers (and its old name), and the first segments of the board's own
 * pages and routes.
 */
export const RESERVED_IDS: ReadonlyArray<string> = [
  "huntaway",
  "issue_agent",
  "gh",
  "docs",
  "desktop",
  "api",
  "plugins",
  "assets",
  "profile",
  "assistant",
  "settings",
  "analytics",
  "guide",
  "hosts",
  "t",
  "g",
  "p",
]

const ID = /^[a-z][a-z0-9_]{0,31}$/

/** Why `id` can't be a plugin's, or null when it can. */
export const pluginIdProblem = (id: string): string | null =>
  !ID.test(id)
    ? `a plugin's id is a lowercase letter, then up to 31 lowercase letters, digits or _: "${id}" isn't`
    : RESERVED_IDS.includes(id)
      ? `${id} is one of the board's own names, so a plugin can't have it`
      : null
