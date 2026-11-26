import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// The output style a Claude task's runs are given (HE-102; docs/plan/07-agents.md, Output styles): a name of Claude
// Code's (`default`, `Explanatory`, a user's or a plugin's), set with `/output-style <name>`; null for whatever Claude
// Code's own settings say.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE tasks ADD COLUMN output_style TEXT`
  }),
})
