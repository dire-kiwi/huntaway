import { DateTime, Effect, Schema, SchemaTransformation } from "effect"
import { Timestamp } from "@huntaway/contracts"

// Column schemas for row schemas (docs/plan/04-database.md, Access): what SQLite stores, turned into what the wire has.
// Shared by every repository.

/** An INTEGER 0/1 column as a boolean; any other number reads as true, as SQLite's own truth does. */
export const Bit = Schema.Finite.pipe(
  Schema.decodeTo(Schema.Boolean, SchemaTransformation.transform<boolean, number>({ decode: (n) => n !== 0, encode: (b) => (b ? 1 : 0) })),
)

/** A nullable INTEGER 0/1 column as a tri-state boolean (null follows something else). */
export const NullableBit = Schema.NullOr(Bit)

/**
 * A JSON TEXT column read leniently (docs/plan/inventory/09-data-model.md, section 3: readers never throw on bad JSON):
 * null, text that does not parse, or a value that does not fit `schema` reads as `fallback`.
 */
export const JsonColumn = <S extends Schema.Codec<unknown, unknown>>(schema: S, fallback: S["Type"]) => {
  const read = Schema.NullOr(Schema.fromJsonString(schema)).pipe(
    Schema.decodeTo(
      Schema.toType(schema),
      SchemaTransformation.transform<S["Type"], S["Type"] | null>({ decode: (value) => value ?? fallback, encode: (value) => value }),
    ),
  )
  return Schema.catchDecoding<typeof read>(() => Effect.succeedSome(fallback))(read)
}

/** A nullable JSON TEXT column: null when unset or unreadable. */
export const NullableJsonColumn = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const read = Schema.NullOr(Schema.fromJsonString(schema))
  return Schema.catchDecoding<typeof read>(() => Effect.succeedSome(null))(read)
}

const jsonText = Schema.fromJsonString(Schema.Unknown)

/** A value as the JSON text a column stores. */
export const toJson = (value: unknown): Effect.Effect<string> => Schema.encodeEffect(jsonText)(value).pipe(Effect.orDie)

/** Now, as rows store it: RFC 3339 UTC with milliseconds. */
export const nowTimestamp: Effect.Effect<Timestamp> = Effect.map(DateTime.now, (now) => Timestamp.make(DateTime.formatIso(now)))

/** What a column is written as. */
export type ColumnValue = string | number | null

/**
 * Values as columns store them, for an INSERT or UPDATE: booleans as 0/1, lists and objects as JSON text, undefined
 * left out.
 */
export const encodeColumns = (values: Readonly<Record<string, unknown>>): Effect.Effect<Record<string, ColumnValue>> =>
  Effect.gen(function* () {
    const out: Record<string, ColumnValue> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      if (value === null || typeof value === "string" || typeof value === "number") out[key] = value
      else if (typeof value === "boolean") out[key] = value ? 1 : 0
      else out[key] = yield* toJson(value)
    }
    return out
  })
