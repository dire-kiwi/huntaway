import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// A task that came into In review and hasn't been opened by the user since (HE-65; docs/plan/03-domain.md): the board
// marks it until they do. 0 for every task there is: what is in review now has been seen as far as anyone can tell.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE tasks ADD COLUMN review_unread INTEGER NOT NULL DEFAULT 0`
  }),
})
