import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

// The worktrees a set's lead was given for one of its runs (HE-118; docs/plan/07-agents.md, Work across repositories):
// a follower's, granted as the run started. While that run is live, the follower's own agent doesn't start and it
// can't leave To do, so no two agents work in one worktree. A run's grants go with it.
export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE run_grants (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (run_id, task_id)
    ) STRICT`
    yield* sql`CREATE INDEX run_grants_task ON run_grants(task_id)`
  }),
})
