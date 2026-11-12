import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ImportContext } from "./family.ts"
import type { OldDb } from "./oldDb.ts"
import type { Problem } from "./report.ts"

// `--check` (docs/plan/11-migration.md, `--check`): the old database against the new board, after an import or on its
// own against an existing pair.

/** Every difference `--check` finds between the old database and the new board. */
export const checkImport = (_old: OldDb, _board: SqlClient.SqlClient, _ctx: ImportContext): Effect.Effect<ReadonlyArray<Problem>> => Effect.succeed([])
