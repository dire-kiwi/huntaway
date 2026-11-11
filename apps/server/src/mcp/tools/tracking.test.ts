import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId, Timestamp } from "@huntaway/contracts"
import { fakeAgent, TestMcp } from "@huntaway/testing"
import { effectiveStatus, MAX_ITEMS, MAX_TITLE } from "../../assistant/tracked.ts"
import { toJson } from "../../platform/columns.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { agentOf, agentOn, at, call, err, ok, profile, project, setTask, task } from "./tests/board.ts"

// The assistant's tracked work (the old agent/assistant/tracked.test.ts), its tools called through `ToolCalls`. Dropped:
// the user's removal from the assistant's details (`POST /tasks/{id}/tracked/remove`), which is the board's `Tracked`
// (6.7); items following a task on a linked host (M7).

const items = (v: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const list = at(v, "items")
  return Array.isArray(list) ? list : assert.fail("no items")
}

/** The assistant's list as stored. */
const stored = (id: string) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (r) => r.get(id)),
    (t) => t?.tracked ?? [],
  )

describe("tracked work", () => {
  it.effect("the assistant tracks its work on its own task and reads it back", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const followed = yield* task(ha, "Add tracked work")
      const a = yield* agentOf(p)
      const added = ok(yield* call(a, "track_work", { title: "Add tracked work", task: "HA-1", status: "waiting_task", note: "its agent is on it" }))
      const item = at(added, "item")
      assert.deepStrictEqual(
        ["title", "status", "note", "task_id", "task_key"].map((k) => at(item, k)),
        ["Add tracked work", "waiting_task", "its agent is on it", followed.id, "HA-1"],
      )
      assert.deepStrictEqual([at(item, "task", "key"), at(item, "task", "status"), at(item, "task", "title")], ["HA-1", "todo", "Add tracked work"])
      assert.strictEqual(String(at(item, "id")).length, 8)
      const doc = at(ok(yield* call(a, "track_work", { title: "Research hosting", url: "https://docs.example/hosting" })), "item")
      assert.deepStrictEqual([at(doc, "status"), at(doc, "url"), at(doc, "task_id")], ["working", "https://docs.example/hosting", null])
      // Kept on the assistant's task, as the board's details read it.
      const kept = yield* stored(a.run.task_id)
      assert.deepStrictEqual(
        kept.map((i) => i.title),
        ["Add tracked work", "Research hosting"],
      )
      // Changed by id: only what's given; "" clears.
      const changed = at(ok(yield* call(a, "track_work", { id: at(doc, "id"), status: "waiting_user", note: "the plan is up for review", url: "" })), "item")
      assert.deepStrictEqual(
        ["title", "status", "note", "url"].map((k) => at(changed, k)),
        ["Research hosting", "waiting_user", "the plan is up for review", null],
      )
      assert.strictEqual(at(changed, "created_at"), at(doc, "created_at"))
      assert.deepStrictEqual(
        items(ok(yield* call(a, "list_tracked_work", {}))).map((i) => [i["title"], i["status"]]),
        [
          ["Add tracked work", "waiting_task"],
          ["Research hosting", "waiting_user"],
        ],
      )
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("an item shows as done once the task it follows is; untrack_work removes by id or the done ones", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const followed = yield* task(ha, "Fix it")
      const a = yield* agentOf(p)
      const item = at(ok(yield* call(a, "track_work", { title: "Fix it", task: followed.id, status: "waiting_task" })), "item")
      yield* setTask(followed.id, { status: "done", resolution: "done" })
      let [shown] = items(ok(yield* call(a, "list_tracked_work", {})))
      assert.deepStrictEqual(
        [shown?.["status"], shown?.["own_status"], at(shown, "task", "status"), at(shown, "task", "resolution")],
        ["done", "waiting_task", "done", "done"],
      )
      // A failed item stays failed.
      yield* call(a, "track_work", { id: at(item, "id"), status: "failed" })
      assert.strictEqual(items(ok(yield* call(a, "list_tracked_work", {})))[0]?.["status"], "failed")
      assert.strictEqual(effectiveStatus({ status: "working" }, { status: "done" }), "done")
      assert.strictEqual(effectiveStatus({ status: "working" }, null), "working")
      assert.strictEqual(effectiveStatus({ status: "waiting_task" }, { status: "in_review" }), "waiting_user")
      // Removed: by id, or every done one (not the failed ones).
      const x = at(ok(yield* call(a, "track_work", { title: "x" })), "item")
      yield* call(a, "track_work", { title: "y", status: "done" })
      yield* call(a, "track_work", { id: at(item, "id"), status: "working" })
      assert.deepStrictEqual(ok(yield* call(a, "untrack_work", { done: true })), { removed: 2, left: 1 })
      assert.deepStrictEqual(ok(yield* call(a, "untrack_work", { ids: [at(x, "id"), "nope"] })), { removed: 1, left: 0 })
      assert.include(err(yield* call(a, "untrack_work", {})), "give the ids")
      // A deleted task leaves the item, with its key and no task.
      const other = yield* task(ha, "Gone")
      yield* call(a, "track_work", { title: "Gone", task: other.id })
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM tasks WHERE id = ${other.id}`.pipe(Effect.orDie)
      ;[shown] = items(ok(yield* call(a, "list_tracked_work", {})))
      assert.deepStrictEqual([shown?.["status"], shown?.["task_key"], shown?.["task"]], ["working", "HA-2", null])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("tracked work is checked, and only the assistant's and its routines'", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const a = yield* agentOf(p)
      assert.include(err(yield* call(a, "track_work", {})), "title is required")
      assert.include(err(yield* call(a, "track_work", { title: "x", status: "busy" })), "track_work's arguments don't fit its schema")
      assert.include(err(yield* call(a, "track_work", { title: "x", url: "file:///etc/passwd" })), "http(s) URL")
      assert.include(err(yield* call(a, "track_work", { title: "x".repeat(MAX_TITLE + 1) })), "too long")
      assert.include(err(yield* call(a, "track_work", { id: "nope", status: "done" })), "no tracked item nope")
      assert.include(err(yield* call(a, "track_work", { title: "x", task: "HA-9" })), "task HA-9")
      const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
      const full = Array.from({ length: MAX_ITEMS }, (_, i) => ({
        id: `i${i}`,
        title: `item ${i}`,
        note: null,
        status: "working",
        task_id: null,
        task_key: null,
        url: null,
        created_at: AT,
        updated_at: AT,
      }))
      const sql = yield* SqlClient.SqlClient
      const json = yield* toJson(full)
      yield* sql`UPDATE tasks SET tracked = ${json} WHERE id = ${a.run.task_id}`.pipe(Effect.orDie)
      assert.include(err(yield* call(a, "track_work", { title: "one more" })), "the most it keeps")

      // A project's agent has no list.
      const worker = yield* task(ha, "Worker")
      const w = yield* agentOn(worker)
      assert.include(err(yield* call(w, "list_tracked_work", {})), "the profile's assistant's")
      assert.include(err(yield* call(w, "track_work", { title: "x" })), "the profile's assistant's")
      assert.deepStrictEqual(yield* stored(worker.id), [])

      // A routine's thread keeps the assistant's list.
      const routine = TaskId.make("routine-1")
      yield* sql`INSERT INTO tasks (id, profile_id, parent_id, title, status, task_type, kind, number, last_activity_at, created_at, updated_at)
        VALUES (${routine}, ${p.id}, ${a.run.task_id}, 'Inbox', 'todo', 'routine', 'task', 2, ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
      const r = yield* fakeAgent({ task: routine })
      assert.deepStrictEqual(ok(yield* call(r, "untrack_work", { ids: ["i0"] })), { removed: 1, left: MAX_ITEMS - 1 })
      assert.strictEqual((yield* stored(a.run.task_id)).length, MAX_ITEMS - 1)
    }).pipe(Effect.provide(TestMcp())),
  )
})
