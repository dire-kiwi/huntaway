import { Effect, Schema } from "effect"
import { decodeOld, issueText } from "../family.ts"
import type { FamilyIo, NewRow, TableCheck } from "../family.ts"

// What the families of tables copied as they are share: old columns that an older database may lack, reading a table's
// old rows, and a rehearsal's withholding of credentials (docs/plan/11-migration.md, Rehearsal).

/** A column an older database may not have: read as `value` when it is missing. */
export const orDefault = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** A nullable column an older database may not have: null when it is missing. */
export const orNull = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S) =>
  orDefault(Schema.NullOr(schema), null)

/** An INTEGER flag as it is stored. */
export const Flag = Schema.Finite

/** The old rows of `table` in `orderBy` order, counted as the old rows behind `counted` and decoded with `schema`. */
export const readOld = <S extends Schema.Decoder<unknown>>(
  io: FamilyIo,
  table: string,
  schema: S,
  key: (row: Readonly<Record<string, unknown>>) => string,
  options: { readonly counted?: string; readonly orderBy?: string } = {},
): Effect.Effect<ReadonlyArray<S["Type"]>> =>
  Effect.gen(function* () {
    const rows = yield* io.old.rows(table, options.orderBy)
    yield* io.report.old(options.counted ?? table, rows.length)
    return yield* decodeOld(io.report, table, schema, key)(rows)
  })

/**
 * Checks rows as the writer does (the row schema, then the JSON columns) without writing them, reporting what fails.
 * How many pass: a rehearsal's withheld credentials.
 */
export const checkRows = (io: FamilyIo, table: string, check: TableCheck, rows: Iterable<NewRow>): Effect.Effect<number> =>
  Effect.gen(function* () {
    const decodeRow = Schema.decodeUnknownResult(check.row)
    const jsonChecks = Object.entries(check.json ?? {}).map(([column, schema]) => [column, Schema.decodeUnknownResult(Schema.fromJsonString(schema))] as const)
    let passed = 0
    for (const row of rows) {
      const decoded = decodeRow(row)
      if (decoded._tag === "Failure") {
        yield* io.report.failure(table, check.key(row), `new row: ${issueText(decoded.failure)}`)
        continue
      }
      for (const [column, decode] of jsonChecks) {
        const value = row[column]
        if (typeof value !== "string") continue
        const result = decode(value)
        if (result._tag === "Failure") yield* io.report.json(table, `${check.key(row)}.${column}`, issueText(result.failure))
      }
      passed++
    }
    return passed
  })

/**
 * Writes `rows`, or in a rehearsal, when they are credentials for something outside the folder, checks them and counts
 * them as withheld instead.
 */
export const writeUnlessRehearsal = (io: FamilyIo, table: string, check: TableCheck, rows: ReadonlyArray<NewRow>): Effect.Effect<number> =>
  io.ctx.rehearsal ? Effect.tap(checkRows(io, table, check, rows), (n) => io.report.withheld(table, n)) : io.write(table, check, rows)
