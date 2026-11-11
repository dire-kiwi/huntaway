import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { PenId, ProjectId, TaskId } from "@huntaway/contracts"
import type { ThreadKindFields } from "@huntaway/contracts"
import { canBeInPen, checkPenName, nextPenColor, penColorOf, penWanted, reordered } from "./penChecks.ts"

/** A task with only what the rules read. */
const task = (fields: Partial<ThreadKindFields>): ThreadKindFields => ({
  id: TaskId.make("t"),
  kind: "task",
  task_type: null,
  project_id: null,
  parent_id: null,
  group_name: null,
  pen_id: null,
  labels: [],
  work_dir: null,
  use_worktree: false,
  ...fields,
})

describe("pen rules", () => {
  it("keep a name trimmed, its spaces collapsed, not blank and at most 60 characters", () => {
    assert.deepStrictEqual(checkPenName("  This   week \t"), Result.succeed("This week"))
    assert.isTrue(Result.isFailure(checkPenName(" \n ")))
    assert.isTrue(Result.isSuccess(checkPenName("x".repeat(60))))
    assert.isTrue(Result.isFailure(checkPenName("x".repeat(61))))
  })

  it("give a new pen the first colour none has, else the first of those fewest have", () => {
    assert.strictEqual(nextPenColor([]), "blue")
    assert.strictEqual(nextPenColor(["blue", "blue", "orange"]), "green")
    assert.strictEqual(penColorOf(""), "blue")
    assert.strictEqual(penColorOf("teal"), "teal")
  })

  it("move a pen's tab to its place, clamped to the ends", () => {
    const pens = ["a", "b", "c"].map((id) => ({ id }))
    const order = (id: string, index: number) => reordered(pens, id, index).map((p) => p.id)
    assert.deepStrictEqual(order("c", 0), ["c", "a", "b"])
    assert.deepStrictEqual(order("a", 1), ["b", "a", "c"])
    assert.deepStrictEqual(order("a", 99), ["b", "c", "a"])
    assert.deepStrictEqual(order("b", -3), ["b", "a", "c"])
    assert.deepStrictEqual(order("b", 1.7), ["a", "b", "c"])
  })

  it("put only a task on the board in a pen; any task can be taken out", () => {
    const code = task({ project_id: ProjectId.make("p") })
    assert.isTrue(canBeInPen(code))
    assert.isTrue(canBeInPen(task({})))
    assert.isTrue(canBeInPen(task({ group_name: "Shop" })))
    for (const off of [
      task({ kind: "review" }),
      task({ task_type: "assistant" }),
      task({ task_type: "routine" }),
      task({ task_type: "pens" }),
      task({ task_type: "pen" }),
    ]) {
      assert.isFalse(canBeInPen(off))
      assert.isTrue(Result.isFailure(penWanted(off, { pen: "Today" })))
      assert.deepStrictEqual(penWanted(off, { pen: " " }), Result.succeed({ _tag: "Out" }))
    }
    assert.deepStrictEqual(penWanted(code, {}), Result.succeed({ _tag: "Keep" }))
    assert.deepStrictEqual(penWanted(code, { pen: null }), Result.succeed({ _tag: "Out" }))
    assert.deepStrictEqual(penWanted(code, { pen_id: null }), Result.succeed({ _tag: "Out" }))
    assert.deepStrictEqual(penWanted(code, { pen: " Today " }), Result.succeed({ _tag: "ByName", name: "Today" }))
    // The name wins over the id.
    assert.deepStrictEqual(penWanted(code, { pen: "Today", pen_id: PenId.make("p1") }), Result.succeed({ _tag: "ByName", name: "Today" }))
    assert.deepStrictEqual(penWanted(code, { pen_id: PenId.make("p1") }), Result.succeed({ _tag: "ById", id: PenId.make("p1") }))
  })
})
