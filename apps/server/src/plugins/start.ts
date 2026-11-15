import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { PluginError, PluginHost, PluginImport } from "@huntaway/plugin"
import type { Plugin, PluginHostShape, PluginImportShape, PluginParts } from "@huntaway/plugin"
import { SECRETS_TABLE } from "./host.ts"

// HE-34: starting one plugin (docs/plan/15-plugins.md, Its database): its folder in the data folder, its own SQLite
// database brought up to date with its migrations, then its `make`, with its services. Any failure is the plugin's:
// `Plugins` lists it with the error and the board carries on.

/**
 * The board's tables each plugin may copy in its migrations (`PluginImport`): what the board had built in that the
 * plugin now does. `docs` is for the documents moving into a plugin of the docs project's (DOC, HE-34).
 */
export const IMPORTABLE: Readonly<Record<string, ReadonlyArray<string>>> = {
  docs: [
    "docs",
    "doc_versions",
    "doc_pages",
    "doc_labels",
    "doc_images",
    "doc_version_images",
    "doc_comments",
    "docs_site_clients",
    "docs_site_connections",
    "docs_site_published",
  ],
}

/** Where a plugin's things are: `<data>/plugins/<id>/`, its database `plugin.db` and its files `files/`. */
export const pluginPaths = (root: string, id: string) => {
  const dir = `${root}/plugins/${id}`
  return { dir, database: `${dir}/plugin.db`, files: `${dir}/files` }
}

const Names = Schema.Array(Schema.Struct({ name: Schema.String }))
const decodeNames = Schema.decodeUnknownEffect(Names)

/**
 * Brings a plugin's database up to its migrations: each not yet recorded in `migrations`, in the order the plugin gives
 * them, in a transaction with its record. One recorded that the plugin no longer has (a newer build's) is left alone.
 * The names of those it applied.
 */
export const migrate = Effect.fn("Plugins.migrate")(function* (plugin: Plugin, sql: SqlClient.SqlClient, importer: PluginImportShape) {
  yield* sql`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS ${sql(SECRETS_TABLE)} (
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, name)
  ) STRICT`
  const all = plugin.migrations ?? []
  const names = all.map((m) => m.name)
  const twice = names.find((n, i) => names.indexOf(n) !== i)
  if (twice !== undefined) return yield* PluginError.failed(`migration ${twice} is listed twice`)
  const applied = new Set((yield* Effect.orDie(decodeNames(yield* sql`SELECT name FROM migrations`))).map((r) => r.name))
  const now: Array<string> = []
  for (const m of all) {
    if (applied.has(m.name)) continue
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* m.run
        yield* sql`INSERT INTO migrations (name, applied_at) VALUES (${m.name}, ${DateTime.formatIso(yield* DateTime.now)})`
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provideService(PluginImport, importer)),
    )
    yield* Effect.logInfo(`plugin ${plugin.id}: applied migration ${m.name}`)
    now.push(m.name)
  }
  return now
})

/** What `start` needs of the board. */
export interface StartDeps {
  readonly root: string
  readonly host: (plugin: string, filesDir: string, sql: SqlClient.SqlClient) => PluginHostShape
  readonly importer: (plugin: string) => PluginImportShape
}

/** Opens a plugin's database (for the server's lifetime), migrates it and builds the plugin. */
export const start = Effect.fn("Plugins.start")(function* (plugin: Plugin, deps: StartDeps) {
  const fs = yield* FileSystem.FileSystem
  const paths = pluginPaths(deps.root, plugin.id)
  yield* fs.makeDirectory(paths.files, { recursive: true, mode: 0o700 })
  yield* fs.chmod(paths.dir, 0o700)
  const context = yield* Layer.build(SqliteClient.layer({ filename: paths.database, busyTimeout: "5 seconds" }))
  const sql = Context.get(context, SqlClient.SqlClient)
  yield* sql`PRAGMA foreign_keys = ON`
  for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) yield* fs.chmod(file, 0o600).pipe(Effect.ignore)
  yield* migrate(plugin, sql, deps.importer(plugin.id))
  const parts: PluginParts = yield* plugin.make.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(PluginHost, deps.host(plugin.id, paths.files, sql)),
  )
  return parts
})

/** A failure while starting a plugin, in a line. */
export const startMessage = (e: SqlError.SqlError | PluginError | { readonly message: string }): string => e.message
