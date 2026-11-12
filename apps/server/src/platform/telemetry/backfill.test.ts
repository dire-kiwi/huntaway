import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestPlatform } from "@huntaway/testing"
import { collect } from "./backfill.ts"

// The old telemetry.test.ts's backfill case: a host's history from before it started sending, for the profiles that
// send, picked by when the server would have sent each row, so nothing is sent twice.

const SINCE = "2026-06-01T00:00:00.000Z"
const BEFORE = "2026-01-01T00:00:00.000Z"
const AFTER = "2026-06-01T00:00:01.000Z"

describe("telemetry backfill", () => {
  it.effect("sends the history of profiles that send from before it started", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO profiles (id, name, created_at, telemetry, telemetry_titles) VALUES ('p', 'personal', ${BEFORE}, 1, 1), ('w', 'work', ${BEFORE}, 0, 0)`
      yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
        VALUES ('proj', 'p', 'Huntaway', 'HA', '/x', '/x', '/x', ${BEFORE})`
      yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, last_activity_at, created_at, updated_at)
        VALUES ('t', 'p', 'proj', 1, 'Secret plans', 'todo', ${BEFORE}, ${BEFORE}, ${BEFORE}), ('wt', 'w', NULL, 1, 'Work', 'todo', ${BEFORE}, ${BEFORE}, ${BEFORE})`
      // A run that started and was counted at these times (counted null: not counted yet).
      let n = 0
      const run = (task: string, started: string, counted: string | null) =>
        Effect.gen(function* () {
          const id = `run-${++n}`
          yield* sql`INSERT INTO runs (id, task_id, status, saw_result, created_at, ended_at, usage_at) VALUES (${id}, ${task}, 'exited', 1, ${started}, ${started}, ${counted})`
          yield* sql`INSERT INTO token_usage (run_id, model, runtime, input_tokens, output_tokens, cost_usd) VALUES (${id}, 'opus', 'claude', 5, 7, 0.5)`
          return id
        })
      const old = yield* run("t", BEFORE, BEFORE)
      yield* sql`UPDATE runs SET ended_at = '2026-01-01T00:01:00.000Z' WHERE id = ${old}`
      // Going when sending started, and counted (so sent by the server) after: not again.
      yield* run("t", BEFORE, AFTER)
      // Not counted yet: the server sends it once it is.
      yield* run("t", BEFORE, null)
      yield* run("t", AFTER, AFTER)
      yield* run("wt", BEFORE, BEFORE)
      // A prompt decided after sending started was sent by the server; one decided before wasn't.
      for (const [id, decided] of [
        ["ToolBefore", BEFORE],
        ["ToolAfter", AFTER],
      ] as const) {
        yield* sql`INSERT INTO approval_log (id, profile_id, task_id, tool_name, summary, rule, decision, outcome, answered_by, created_at, decided_at)
          VALUES (${`a-${id}`}, 'p', 't', ${id}, '', 'Bash', 'ask', 'allowed', 'user', ${BEFORE}, ${decided})`
      }
      // An automation's run, by when it finished.
      yield* sql`INSERT INTO automations (id, profile_id, name, trigger, action, token, created_at, updated_at) VALUES ('auto', 'p', 'nightly', '{}', '{}', 't', ${BEFORE}, ${BEFORE})`
      yield* sql`INSERT INTO automation_runs (id, automation_id, source, status, created_at, finished_at) VALUES ('ar-before', 'auto', 'schedule', 'ok', ${BEFORE}, ${BEFORE}),
        ('ar-after', 'auto', 'schedule', 'ok', ${BEFORE}, ${AFTER})`

      const batches = yield* collect(SINCE)
      const rows = batches.flatMap((b) => b.rows)
      assert.deepStrictEqual(
        rows.map((r) => [r["event"], r["run_id"] ?? r["tool"] ?? "", r["model"] ?? ""]),
        [
          ["run_usage", old, "opus"],
          ["run_end", old, "opus"],
          ["permission", "ToolBefore", ""],
          ["automation_run", "", ""],
        ],
      )
      assert.strictEqual(rows[1]?.["duration_ms"], 60_000)
      assert.strictEqual(rows[1]?.["cost_usd"], 0.5)
      assert.strictEqual(rows[1]?.["task_key"], "HA-1")
      assert.strictEqual(rows[3]?.["ts"], BEFORE)
      // The same rows make the same tokens.
      assert.deepStrictEqual(
        (yield* collect(SINCE)).map((b) => b.key),
        batches.map((b) => b.key),
      )
    }).pipe(Effect.scoped, Effect.provide(TestPlatform())),
  )
})
