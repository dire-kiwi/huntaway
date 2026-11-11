import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestMcp } from "@huntaway/testing"
import { PenRepo } from "../../tasks/PenRepo.ts"
import { Pens } from "../../tasks/Pens.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { agentOf, agentOn, call, err, list, ok, profile, project, setTask, task } from "./tests/board.ts"

// The pen tools that change pens (the old mcp/tools/pens.test.ts), as an agent calls them through `ToolCalls`. Moving
// tasks between pens (`update_task`'s and `create_task`'s `pen`) and `list_pens` are in tasks.test.ts. Dropped, with
// why: the API's and the database's cases (`the_api_moves_tasks…`, `a_database_from…`, `pens_from_before…`), the
// pens' threads (`each_pen_has_its_own_thread…`, the pens thread's prompt), linked hosts (`older_hosts…`: M7), and the
// old texts for a wrong type ("active must be true or false", "colour must be one of"): the arguments' schema refuses
// them now, with a colour in another case ("Teal") among them.

describe("pen tools", () => {
  it.effect("agents make, change and delete pens", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const web = yield* project(p, "web", "WEB")
      const t = yield* task(web, "Web thing")
      const me = yield* agentOf(p)
      const made = ok(yield* call(me, "create_pen", { name: "Today" }))
      assert.deepStrictEqual([made["name"], made["index"], made["active"], made["tasks"], made["profile"]], ["Today", 0, true, [], "personal"])
      yield* call(me, "update_task", { task_id: "WEB-1", pen: "today" })
      yield* call(me, "create_pen", { name: "Parked" })
      // Made inactive, renamed and moved to the front.
      const parked = ok(yield* call(me, "update_pen", { pen: "parked", active: false, name: "Later on", index: 0 }))
      assert.deepStrictEqual([parked["active"], parked["name"], parked["index"]], [false, "Later on", 0])
      assert.deepStrictEqual(
        list(yield* call(me, "list_pens", {})).map((x) => [x["name"], x["index"], x["active"]]),
        [
          ["Later on", 0, false],
          ["Today", 1, true],
        ],
      )
      // Active again, leaving the rest as it was; and a pen can start inactive.
      assert.deepStrictEqual(
        [ok(yield* call(me, "update_pen", { pen: "Later on", active: true }))["active"], (yield* (yield* PenRepo).get(String(parked["id"])))?.name],
        [true, "Later on"],
      )
      assert.isFalse(ok(yield* call(me, "create_pen", { name: "Someday", active: false }))["active"])
      assert.include(err(yield* call(me, "create_pen", { name: "Bad", active: "no" })), "create_pen's arguments don't fit its schema")
      yield* call(me, "delete_pen", { pen: "Someday" })
      assert.include(err(yield* call(me, "update_pen", { pen: "Today", name: "later ON" })), "already")
      assert.isTrue(err(yield* call(me, "create_pen", { name: "  " })).length > 0)
      // Colours: picked, changed, listed, and checked.
      assert.strictEqual(ok(yield* call(me, "update_pen", { pen: "today", color: "red" }))["color"], "red")
      assert.strictEqual(list(yield* call(me, "list_pens", {})).find((x) => x["name"] === "Today")?.["color"], "red")
      assert.strictEqual(ok(yield* call(me, "create_pen", { name: "Teal", color: "teal" }))["color"], "teal")
      assert.include(err(yield* call(me, "update_pen", { pen: "today", color: "mauve" })), "update_pen's arguments don't fit its schema")
      // A pen deleted: its tasks stay, in no pen.
      assert.deepStrictEqual(ok(yield* call(me, "delete_pen", { pen: "Today" })), { deleted: "Today", tasks_left_in_no_pen: 1 })
      assert.isNull((yield* (yield* TaskRepo).get(t.id))?.pen_id)
      assert.include(err(yield* call(me, "delete_pen", { pen: "Today" })), "pen Today")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("another profile's pens are out of reach, and a pen's own thread can't delete its pen", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const web = yield* project(p, "web", "WEB")
      const me = yield* agentOf(p)
      const work = yield* profile("work")
      const pens = yield* Pens
      const theirs = yield* pens.create({ profile_id: work.id, name: "Secret" })
      assert.strictEqual(err(yield* call(me, "update_pen", { pen: theirs.id, active: false })), `not found: pen ${theirs.id}`)
      assert.strictEqual(err(yield* call(me, "delete_pen", { pen: "Secret" })), "not found: pen Secret")
      // A pen's own thread.
      const today = yield* pens.create({ profile_id: p.id, name: "Today" })
      const thread = yield* task(web, "Pen thread")
      yield* setTask(thread.id, { task_type: "pen", project_id: null, pen_id: today.id })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE pens SET thread_id = ${thread.id} WHERE id = ${today.id}`.pipe(Effect.orDie)
      const its = yield* agentOn(thread)
      assert.include(err(yield* call(its, "delete_pen", { pen: "Today" })), "can't delete its pen")
      assert.isNotNull(yield* (yield* PenRepo).get(today.id))
      // By anyone else, it goes with its thread.
      yield* call(me, "delete_pen", { pen: "Today" })
      assert.isNull(yield* (yield* PenRepo).get(today.id))
      // A pen named by its id.
      const bare = ok(yield* call(me, "create_pen", { name: "Bare" }))
      assert.deepStrictEqual(ok(yield* call(me, "delete_pen", { pen: String(bare["id"]) })), { deleted: "Bare", tasks_left_in_no_pen: 0 })
    }).pipe(Effect.provide(TestMcp())),
  )
})
