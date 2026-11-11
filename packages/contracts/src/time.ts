import { Schema } from "effect"

/**
 * A point in time on the wire and in the database: RFC 3339, UTC, with milliseconds ("2026-11-11T06:16:59.131Z").
 * Compared as strings, as the old board does. Inside the server, convert at the point of use (`DateTime.makeUnsafe`).
 */
export const Timestamp = Schema.String.pipe(Schema.brand("Timestamp"))
export type Timestamp = typeof Timestamp.Type
