import { assert, describe, it } from "@effect/vitest"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { task } from "../merge/tests/rows.ts"
import { settleThreads } from "./StackThreads.ts"

// Where a change leaves a project's stack threads (HE-105), as a pure plan over the rows as they are now and the changed
// task before and after: the reactor may come to a change late, after later ones, so the plan reads the old stack from
// the change itself.

const on = (id: string, below: string, over: Partial<Task> = {}) => task(id, { start_from: { type: "task", task_id: TaskId.make(below) }, ...over })
const thread = (id: string, under: string, made = "2026-11-01T10:00:00.000Z") =>
  task(id, { task_type: "stack", parent_id: TaskId.make(under), created_at: Timestamp.make(made) })
const T = (id: string) => TaskId.make(id)

describe("settleThreads", () => {
  it("follows the level held on a deleted middle level, or the part still a stack", () => {
    const a = task("a")
    const b = on("b", "a")
    // b deleted: c is held on it, and a is alone.
    assert.deepStrictEqual(settleThreads([a, on("c", "b"), thread("s", "a")], b, null), { moves: [{ id: T("s"), to: T("c") }], drops: [] })
    // With d on c, c is a stack's bottom.
    assert.deepStrictEqual(settleThreads([a, on("c", "b"), on("d", "c"), thread("s", "a")], b, null), { moves: [{ id: T("s"), to: T("c") }], drops: [] })
    // Still a stack below the deleted one: it stays there.
    assert.deepStrictEqual(settleThreads([task("z"), on("a", "z"), on("c", "b"), thread("s", "z")], on("b", "a"), null), { moves: [], drops: [] })
  })

  it("decides a change it comes to late from the change, not from what changed since", () => {
    // b's creation, read after b was deleted: it touches no stack.
    assert.deepStrictEqual(settleThreads([task("a"), on("c", "b"), thread("s", "a")], null, on("b", "a")), { moves: [], drops: [] })
  })

  it("moves to a new bottom, follows a split, and goes once no part of its stack has a home", () => {
    // a put on z: z is the bottom.
    assert.deepStrictEqual(settleThreads([task("z"), on("a", "z"), on("b", "a"), thread("s", "a")], task("a"), on("a", "z")), {
      moves: [{ id: T("s"), to: T("z") }],
      drops: [],
    })
    // b off a: a is alone, b and c are a stack.
    assert.deepStrictEqual(settleThreads([task("a"), task("b"), on("c", "b"), thread("s", "a")], on("b", "a"), task("b")), {
      moves: [{ id: T("s"), to: T("b") }],
      drops: [],
    })
    // A held level closed: nothing's left.
    const closed = on("c", "b", { status: "done", resolution: "not_done" })
    assert.deepStrictEqual(settleThreads([task("a"), closed, thread("s", "c")], on("c", "b"), closed), { moves: [], drops: [T("s")] })
  })

  it("keeps the older thread of two stacks joined, from the stack that moved too", () => {
    // c (with d on it, and the older thread) put on b: a's thread is the newer, and goes.
    const rows = [task("a"), on("b", "a"), on("c", "b"), on("d", "c"), thread("s", "a", "2026-11-02T10:00:00.000Z"), thread("t", "c")]
    assert.deepStrictEqual(settleThreads(rows, task("c"), on("c", "b")), { moves: [{ id: T("t"), to: T("a") }], drops: [T("s")] })
  })

  it("leaves a part that's all done for one with work still to land", () => {
    // a and b merged, and b being deleted: c is taken off it (unstacked) first, leaving a and b, all done.
    const merged = { status: "done", resolution: "done" } as const
    const rows = [task("a", merged), on("b", "a", merged), task("c"), on("d", "c"), thread("s", "a")]
    assert.deepStrictEqual(settleThreads(rows, on("c", "b"), task("c")), { moves: [{ id: T("s"), to: T("c") }], drops: [] })
  })

  it("keeps the older thread of two stacks joined", () => {
    const rows = [task("a"), on("b", "a"), on("c", "b"), on("d", "c"), thread("s", "a"), thread("t", "c", "2026-11-02T10:00:00.000Z")]
    assert.deepStrictEqual(settleThreads(rows, task("c"), on("c", "b")), { moves: [], drops: [T("t")] })
  })
})
