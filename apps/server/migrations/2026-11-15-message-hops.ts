import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Hops between agents (HE-26; docs/plan/07-agents.md, Hops between agents). A queued or steered message keeps how many
// agent-to-agent messages led to it (0: the user's or the board's own), and a run the hops of the message its current
// turn took in last, so that `send_to_task` can refuse a chain of agents waking each other past `MAX_HOPS`, across a
// restart too.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE task_queue ADD COLUMN hops INTEGER NOT NULL DEFAULT 0`
    yield* sql`ALTER TABLE task_steers ADD COLUMN hops INTEGER NOT NULL DEFAULT 0`
    yield* sql`ALTER TABLE runs ADD COLUMN hops INTEGER NOT NULL DEFAULT 0`
  }),
})
