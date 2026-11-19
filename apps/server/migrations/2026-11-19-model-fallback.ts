import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// A task whose session Claude Code moved to another model (HE-59; docs/plan/07-agents.md, Model fallback): Opus 5.5's
// safeguards flag a session and Opus 4.8 answers it from then on. JSON (`ModelFallback`), null while the session runs on
// the model it asked for.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE tasks ADD COLUMN model_fallback TEXT`
  }),
})
