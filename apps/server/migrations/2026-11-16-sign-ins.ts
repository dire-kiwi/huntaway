import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Sign-ins for Spaces (HE-48; docs/plan/06-server.md, Spaces): a profile's saved logins (a site's origin, its sign-in
// page, a username and its password), which the host's server types into a Space's browser when the user allows it.
// The password is read only by `SignInRepo`, as a `Redacted` (docs/plan/04-database.md, secrets).
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE sign_ins (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      login_url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    ) STRICT`
    yield* sql`CREATE INDEX sign_ins_profile ON sign_ins (profile_id, origin)`
  }),
})
