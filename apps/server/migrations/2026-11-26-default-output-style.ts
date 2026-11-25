import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// The output style a project's and a profile's Claude tasks are given when they have none of their own (HE-111;
// docs/plan/07-agents.md, Output styles): a name of Claude Code's, as a task's `output_style` is; null follows the
// profile (for a project) or Claude Code's own settings (for a profile).
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE projects ADD COLUMN output_style TEXT`
    yield* sql`ALTER TABLE profiles ADD COLUMN default_output_style TEXT`
  }),
})
