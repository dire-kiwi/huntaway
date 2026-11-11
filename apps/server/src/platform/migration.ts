import type { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"

/**
 * A named migration (docs/plan/04-database.md, Migrations): a file `apps/server/migrations/YYYY-MM-DD-a-few-words.ts`
 * whose default export is `migration({ … })`. Once on `main` a migration is never edited, renamed or deleted.
 */
export interface Migration {
  /** Migrations this one must run after, by name (the file name without `.ts`). Needed when it changes rows or rebuilds a table. */
  readonly after?: ReadonlyArray<string>
  /** `false` runs it with `PRAGMA foreign_keys = OFF`, for a table rebuild. */
  readonly foreignKeys?: boolean
  readonly run: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
}

export const migration = (m: Migration): Migration => m
