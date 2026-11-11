import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// Permissions (HE-4, plan task 3.3). A prompt's `run_id` is the run whose call asked (null for none); `control_id` a
// can_use_tool prompt's control request, and `answered` whether its answer is on the run's input, so a re-attached run's
// open prompts are asked again and answered once.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE permission_requests ADD COLUMN run_id TEXT`
    yield* sql`ALTER TABLE permission_requests ADD COLUMN control_id TEXT`
    yield* sql`ALTER TABLE permission_requests ADD COLUMN answered INTEGER NOT NULL DEFAULT 0`
    yield* sql`CREATE INDEX permission_requests_run ON permission_requests(run_id) WHERE run_id IS NOT NULL`
  }),
})
