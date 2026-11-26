import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Sets of tasks across repositories (HE-117; docs/plan/07-agents.md, Work across repositories): a set's other tasks
// name its lead. Null for the lead and for every task not in a set, which is every task there is.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE tasks ADD COLUMN lead_id TEXT`
    yield* sql`CREATE INDEX tasks_lead ON tasks(lead_id) WHERE lead_id IS NOT NULL`
  }),
})
