import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Teleports brought into a Space (HE-49; docs/plan/06-server.md, Spaces). A Space has no table of its own (it is a
// Docker container), but a teleport's `import_id` has to be kept so "Remove sign-ins" can wipe it (`WipeImport`), and
// the host's page can list what landed. One row a teleport, dropped when its Space is removed.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE space_teleports (
        import_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        app TEXT NOT NULL,
        label TEXT NOT NULL,
        site_count INTEGER NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT`
    yield* sql`CREATE INDEX space_teleports_space ON space_teleports (space_id)`
  }),
})
