import { Effect, Schema } from "effect"
import type { FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { ColumnValue } from "../../platform/columns.ts"
import type { OldDb } from "./oldDb.ts"
import type { Report } from "./report.ts"

// One table family of the importer (docs/plan/11-migration.md, Table by table): the old tables it reads, the new
// tables it writes, and how. Each family is a module of `families/` with its conversion as pure functions from old rows
// to new rows, tested on their own, and a `run` that reads the old rows, converts them and writes them through `io`.

/** What every family knows about the import. */
export interface ImportContext {
  /** The old data folder, as a real absolute path. Relative paths in old rows are relative to it. */
  readonly oldDataDir: string
  /** The new data folder, as a real absolute path. */
  readonly newDataDir: string
  /** A rehearsal: credentials for things outside the folder are converted and checked, not written. */
  readonly rehearsal: boolean
  /** `--force`: live runs are recorded as interrupted rather than refusing (a rehearsal does the same). */
  readonly force: boolean
  /** When the import runs, as rows store time (RFC 3339 UTC with milliseconds). */
  readonly now: string
}

/** A row as it is written: column name to the value SQLite stores. */
export type NewRow = Readonly<Record<string, ColumnValue>>

/** How one new table's rows are checked before they are written. */
export interface TableCheck {
  /**
   * The schema the server reads the row with (its repository's row schema, or the same columns): a row that fails it is
   * a failure in the report and is not written.
   */
  readonly row: Schema.Decoder<unknown>
  /**
   * JSON columns checked strictly with the schema of their value (the server reads them leniently, so a bad value reads
   * as its fallback). A value that fails is listed in the report under `json`; the row is still written.
   */
  readonly json?: Readonly<Record<string, Schema.Decoder<unknown>>>
  /** The row's key in the report: its id, or the columns that make it unique. */
  readonly key: (row: NewRow) => string
}

/** What a family's `run` can do. */
export interface FamilyIo {
  readonly ctx: ImportContext
  readonly old: OldDb
  readonly report: Report
  /**
   * Checks `rows` with `check` and writes the ones that pass into `table` of the new board (in batches, each a
   * transaction). Returns how many were written. In a rehearsal, a family leaves out what must not be written itself.
   */
  readonly write: (table: string, check: TableCheck, rows: Iterable<NewRow>) => Effect.Effect<number>
  /** One statement on the new board (a counter, a fix-up), after the family's rows are written. */
  readonly exec: (sql: string, params?: ReadonlyArray<ColumnValue>) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
}

/** What a family may use besides `io`: the file system (a path on disk), and git (whether a folder is a repository). */
export type FamilyServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export interface Family {
  /** Its name in the report and the log. */
  readonly name: string
  /** Every old table it reads, so the check can name an old table that no family accounted for. */
  readonly reads: ReadonlyArray<string>
  /** Every new table it writes, in order. */
  readonly writes: ReadonlyArray<string>
  readonly run: (io: FamilyIo) => Effect.Effect<void, never, FamilyServices>
}

/**
 * Decodes old rows of `table` with `schema` (a hand-written schema of what is actually there, legacy forms included).
 * A row that does not decode is a failure in the report under `table` and `key(row)`, and is left out.
 */
export const decodeOld = <S extends Schema.Decoder<unknown>>(
  report: Report,
  table: string,
  schema: S,
  key: (row: Readonly<Record<string, unknown>>) => string,
) => {
  const decode = Schema.decodeUnknownResult(schema)
  return (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Effect.Effect<ReadonlyArray<S["Type"]>> =>
    Effect.gen(function* () {
      const out: Array<S["Type"]> = []
      for (const row of rows) {
        const result = decode(row)
        if (result._tag === "Success") out.push(result.success)
        else yield* report.failure(table, key(row), `old row: ${issueText(result.failure)}`)
      }
      return out
    })
}

/** A schema error as one line for the report. */
export const issueText = (error: Schema.SchemaError): string => error.message.replace(/\s+/g, " ").slice(0, 500)

/** A column's value as text for a key. */
const keyText = (value: unknown): string => (typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : "")

/** A key of string columns, for the report: `a/b`. */
export const keyOf =
  (...columns: ReadonlyArray<string>) =>
  (row: Readonly<Record<string, unknown>>): string =>
    columns.map((c) => keyText(row[c])).join("/")
