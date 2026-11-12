import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { fileURLToPath } from "node:url"

// An old board's data folder for the importer's tests (docs/plan/11-migration.md): `huntaway-2.db` made from the old
// schema (`fixtures/legacy/schema.sql`, dumped from a database the old repository's test server made at f2298f0c: schema
// version 130 and its four named migrations), with `host_id` and the tokens beside it. Tests put the rows they need in
// with `run`. It holds no real data.

/** The old schema, as `sqlite3 .schema` printed it, with `user_version` and the named migrations' rows. */
export const legacySchemaFile = fileURLToPath(new URL("../fixtures/legacy/schema.sql", import.meta.url))

export interface LegacyBoard {
  /** The old data folder. */
  readonly root: string
  /** Its database file. */
  readonly database: string
  /** A statement on the old database, with `?` parameters. */
  readonly run: (sql: string, params?: ReadonlyArray<string | number | null>) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
  /** Inserts one row into `table`. */
  readonly insert: (table: string, row: Readonly<Record<string, string | number | null>>) => Effect.Effect<void>
}

/**
 * An old data folder in `root` (made if missing). The database stays open for the scope; close it (end the scope) before
 * importing it for real, since the importer refuses an old database a process has open.
 */
export const makeLegacyBoard = Effect.fn("makeLegacyBoard")(function* (root: string, options: { readonly hostId?: string } = {}) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(root, { recursive: true })
  const database = `${root}/huntaway-2.db`
  const context = yield* Layer.build(Layer.orDie(SqliteClient.layer({ filename: database })))
  const sql = Context.get(context, SqlClient.SqlClient)
  const schema = yield* fs.readFileString(legacySchemaFile)
  // The dump is one statement per `;` at the end of a line (triggers end with `END;`).
  const statements = schema
    .split(/;\s*\n/)
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter((s) => s !== "")
  const triggerParts: Array<string> = []
  for (const statement of statements) {
    // A trigger's body has `;` inside it: join its pieces up to its `END`.
    if (triggerParts.length > 0 || /^CREATE TRIGGER/i.test(statement)) {
      triggerParts.push(statement)
      if (/END$/i.test(statement)) {
        yield* sql.unsafe(triggerParts.join(";\n")).pipe(Effect.orDie)
        triggerParts.length = 0
      }
      continue
    }
    yield* sql.unsafe(statement).pipe(Effect.orDie)
  }
  yield* fs.writeFileString(`${root}/host_id`, `${options.hostId ?? "old-host-0000"}\n`)
  yield* fs.writeFileString(`${root}/auth_token`, "old-board-token\n")
  yield* fs.writeFileString(`${root}/hub_token`, "old-hub-token\n")
  const run = (statement: string, params: ReadonlyArray<string | number | null> = []) =>
    sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.orDie)
  const board: LegacyBoard = {
    root,
    database,
    run,
    insert: (table, row) => {
      const columns = Object.keys(row)
      return Effect.asVoid(run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, Object.values(row)))
    },
  }
  return board
})
