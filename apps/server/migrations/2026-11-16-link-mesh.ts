import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"
// The mesh of hosts (HE-46; docs/plan/08-hosts.md, The mesh). A link's Mesh switch: the host it links may reach this
// board back, and the hosts it reaches. On by default, the old links too: linking two hosts makes one board of them.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE links ADD COLUMN mesh INTEGER NOT NULL DEFAULT 1`
  }),
})
