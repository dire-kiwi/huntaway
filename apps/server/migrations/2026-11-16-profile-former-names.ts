import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"
// A profile's former names (HE-46; docs/plan/08-hosts.md, The mesh): settings sync tells a profile renamed from one
// removed, so the other hosts rename theirs rather than delete it and make an empty one.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE profile_former_names (
      name TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
    ) STRICT`
  }),
})
