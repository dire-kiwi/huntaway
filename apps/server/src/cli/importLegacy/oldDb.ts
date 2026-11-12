import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ColumnValue } from "../../platform/columns.ts"

// The old board's database as the importer reads it: a copy in the new folder (never the old file itself), opened on its
// own connection. Old databases differ in column order and may hold tables or columns from branches that never merged
// (docs/plan/inventory/09-data-model.md, section 9, item 17), so rows are read by column name and a family asks whether
// a column is there before it relies on it.

export interface OldDb {
  /** The tables it has. */
  readonly tables: ReadonlySet<string>
  /** A table's columns; empty for a table it does not have. */
  readonly columns: (table: string) => ReadonlySet<string>
  /** Every row of `table` (none if it has no such table), in `orderBy` order (`rowid` when not given). */
  readonly rows: (table: string, orderBy?: string) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>
  /** A query of its own. */
  readonly query: (sql: string, params?: ReadonlyArray<ColumnValue>) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>
  /** `PRAGMA user_version`. */
  readonly version: number
  /** The names in `named_migrations`. */
  readonly named: ReadonlyArray<string>
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

/** The reader over a connection to the copy. */
export const makeOldDb = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const query = (statement: string, params: ReadonlyArray<ColumnValue> = []) =>
    sql.unsafe<Readonly<Record<string, unknown>>>(statement, params).pipe(Effect.orDie)
  const tableRows = yield* query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  const tables = new Set(tableRows.map((r) => String(r["name"])))
  const columns = new Map<string, ReadonlySet<string>>()
  for (const table of tables) {
    const info = yield* query(`SELECT name FROM pragma_table_info(?)`, [table])
    columns.set(table, new Set(info.map((r) => String(r["name"]))))
  }
  const version = Number((yield* query(`PRAGMA user_version`))[0]?.["user_version"] ?? 0)
  const named = tables.has("named_migrations") ? (yield* query(`SELECT name FROM named_migrations ORDER BY name`)).map((r) => String(r["name"])) : []
  const db: OldDb = {
    tables,
    columns: (table) => columns.get(table) ?? new Set(),
    rows: (table, orderBy = "rowid") => (tables.has(table) ? query(`SELECT * FROM ${quoteName(table)} ORDER BY ${orderBy}`) : Effect.succeed([])),
    query,
    version,
    named,
  }
  return db
})
