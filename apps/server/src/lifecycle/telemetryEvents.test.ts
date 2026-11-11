import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { fakeClickHouse, TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Telemetry } from "../platform/Telemetry.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Reactor } from "./Reactor.ts"

// The old telemetry.test.ts's "a status change sends its event", on the whole board: the reactor sends `task_status`
// for a task whose status moved, with where it moved from.

const AT = "2026-09-01T00:00:00.000Z"

describe("telemetry's events", () => {
  it.effect("a status change sends `task_status`", () =>
    Effect.gen(function* () {
      const f = yield* fakeClickHouse
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO profiles (id, name, created_at, telemetry) VALUES ('p', 'personal', ${AT}, 1)`
      yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at) VALUES ('t', 'p', 'A task', 'todo', ${AT}, ${AT}, ${AT})`
      yield* (yield* Telemetry).update({ url: f.url })
      yield* (yield* Tasks).update(TaskId.make("t"), { status: "in_review" }, Actor.user)
      yield* (yield* Reactor).idle
      const rows = yield* sql<{ readonly row: string }>`SELECT row FROM telemetry_outbox WHERE row LIKE '%task_status%'`
      assert.strictEqual(rows.length, 1)
      assert.include(rows[0]?.row ?? "", '"status":"in_review"')
      assert.include(rows[0]?.row ?? "", '"attrs":{"from":"todo"}')
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
