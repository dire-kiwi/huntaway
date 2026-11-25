import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Whether a Claude run's session works in Code Mode (HE-107; docs/plan/07-agents.md, Code Mode): its `init` listed
// Claude Code's REPL tool. Read on the session's first run, as `board_tools` is: a session keeps the mode it started
// in, and Claude Code refuses to resume a Code Mode session in a run that isn't asked for it.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE runs ADD COLUMN code_mode INTEGER NOT NULL DEFAULT 0`
  }),
})
