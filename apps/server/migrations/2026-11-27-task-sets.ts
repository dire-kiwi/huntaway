import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Sets of tasks across repositories (HE-117; docs/plan/07-agents.md, Work across repositories): a set's other tasks
// name its lead, and each of its tasks keeps the branch name its worktree is to be made on until it is (`branch` stays
// null until git has the branch). Both null for every task there is.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE tasks ADD COLUMN lead_id TEXT`
    yield* sql`ALTER TABLE tasks ADD COLUMN set_branch TEXT`
    yield* sql`CREATE INDEX tasks_lead ON tasks(lead_id) WHERE lead_id IS NOT NULL`
  }),
})
