import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// An ACP agent config's command line (HE-69; docs/plan/07-agents.md, ACP agents): the program and its arguments that
// speak the Agent Client Protocol, null for the default (`agy acp`) and for every Claude Code and Codex config.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE agent_configs ADD COLUMN command TEXT`
  }),
})
