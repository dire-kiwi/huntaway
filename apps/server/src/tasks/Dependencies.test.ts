import { assert, describe, it as vit, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ProjectId, TaskId } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Dependencies, isMerged } from "./Dependencies.ts"

const now = "2026-11-12T00:00:00.000Z"

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('pr', 'p', ${now})`
  for (const [id, archived] of [
    ["p1", null],
    ["p2", now],
  ] as const) {
    yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at, archived_at)
      VALUES (${id}, 'pr', ${id}, ${id.toUpperCase()}, '/nonexistent', '/nonexistent', '/nonexistent', ${now}, ${archived})`
  }
  const task = (id: string, project: string, fields: { status?: string; resolution?: string | null; depends_on?: ReadonlyArray<string>; waiting?: boolean }) =>
    sql`INSERT INTO tasks (id, profile_id, project_id, title, status, resolution, depends_on, waiting, last_activity_at, created_at, updated_at)
      VALUES (${id}, 'pr', ${project}, ${id}, ${fields.status ?? "todo"}, ${fields.resolution ?? null}, ${`[${(fields.depends_on ?? []).map((d) => `"${d}"`).join(",")}]`},
        ${fields.waiting === true ? 1 : 0}, ${now}, ${now}, ${now})`
  yield* task("merged", "p1", { status: "done", resolution: "done" })
  yield* task("wontfix", "p1", { status: "done", resolution: "wont_fix" })
  yield* task("open", "p1", {})
  yield* task("ready", "p1", { status: "in_progress", waiting: true, depends_on: ["merged", "deleted"] })
  yield* task("blocked", "p1", { status: "in_progress", waiting: true, depends_on: ["merged", "open"] })
  yield* task("notMerged", "p1", { status: "in_progress", waiting: true, depends_on: ["wontfix"] })
  yield* task("archived", "p2", { status: "in_progress", waiting: true, depends_on: [] })
})

layer(TestBoard())("Dependencies", (it) => {
  it.effect("finds waiting tasks whose dependencies are all merged (deleted ones don't count), not in archived projects", () =>
    Effect.gen(function* () {
      yield* seed
      const dependencies = yield* Dependencies
      assert.deepStrictEqual(yield* dependencies.ready(ProjectId.make("p1")), [TaskId.make("ready")])
      assert.deepStrictEqual(yield* dependencies.ready(null), [TaskId.make("ready")])
      yield* dependencies.reconcile(null)
    }),
  )
})

describe("isMerged", () => {
  vit("is done with no resolution or a done one", () => {
    assert.isTrue(isMerged({ status: "done", resolution: null }))
    assert.isTrue(isMerged({ status: "done", resolution: "done" }))
    assert.isFalse(isMerged({ status: "done", resolution: "wont_fix" }))
    assert.isFalse(isMerged({ status: "in_review", resolution: null }))
  })
})
