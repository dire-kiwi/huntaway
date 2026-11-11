import { assert, describe, it } from "@effect/vitest"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { activeMerge, heldReasonOf, mergeLane, queuedMerges, stackLine, stackOf, stackRunLanes, stackState } from "../tasks/lanes.ts"
import { awaitsApprovals, decideLanes, settleStackRuns } from "./decide.ts"
import type { LaneFacts } from "./decide.ts"
import { task } from "./tests/rows.ts"

// The merge queue's lane rules as a table over task rows (huntaway's db/tasks/merges.ts and db/tasks/stacks.ts, and
// agent/runner/merge.ts `start_next_merge`): the lane cases of the old agent/runner/merge.test.ts, api/tasks.test.ts,
// api/incoming.test.ts, api/stacks.test.ts and api/stack_merge.test.ts, as the rows each one reached. What a case did
// beyond the rows (the prompt, the board's moves) is in Merges.test.ts.

const AT = Timestamp.make("2026-11-01T10:00:00.000Z")

/** Queued in Ready for merge. */
const queued: Partial<Task> = { status: "ready_for_merge", merging: true }
/** Merging: its agent has the merge. */
const merging: Partial<Task> = { status: "ready_for_merge", merging: true, running: true }
const merged: Partial<Task> = { status: "done", resolution: "done" }
const closed: Partial<Task> = { status: "done", resolution: "not_done" }
const into = (id: string): Partial<Task> => ({ merges_into: TaskId.make(id), start_from: { type: "task", task_id: TaskId.make(id) } })
const on = (id: string): Partial<Task> => ({ start_from: { type: "task", task_id: TaskId.make(id) }, base_branch: `ia/x-${id}` })

/** Task A as `a`, and B queued behind it. */
const slotRows = (a: Partial<Task>) => [task("a", a), task("b", queued)]
/** Level L, queued, on B. */
const stackLevel = (over: Partial<Task> = {}) => task("l", { ...queued, ...on("b"), ...over })

const plan = (tasks: ReadonlyArray<Task>, over: Partial<LaneFacts> = {}) => {
  const p = decideLanes({ tasks, finished: new Set(), archived: false, approvalRequired: false, ...over })
  return {
    leaveRun: p.leaveRun.map((l) => `${l.id}${l.said ? "!" : ""}`),
    summarise: p.summarise.map((t) => String(t.id)),
    start: p.start.map((t) => String(t.id)),
  }
}
const none: { leaveRun: Array<string>; summarise: Array<string>; start: Array<string> } = { leaveRun: [], summarise: [], start: [] }

describe("lanes", () => {
  it("tasks merging into one task merge one at a time in a lane of their own; a chain in its first open target's", () => {
    const target = task("t")
    const a = task("a", into("t"))
    const other = task("o")
    const rows = [target, a, other]
    assert.strictEqual(mergeLane(rows, a), "t")
    assert.strictEqual(mergeLane(rows, other), null)
    // A into B into C: C's lane, and once B is merged, still C's.
    const c = task("c")
    const b = task("b", into("c"))
    const x = task("x", into("b"))
    assert.strictEqual(mergeLane([c, b, x], x), "b")
    assert.strictEqual(mergeLane([c, task("b", { ...into("c"), ...merged }), x], x), "c")
    // All merged: the project's lane. Closed: none (and held).
    assert.strictEqual(mergeLane([task("c", merged), task("b", { ...into("c"), ...merged }), x], x), null)
    assert.strictEqual(mergeLane([task("t", closed), a], a), null)
  })

  it("a stack level merges in the lane of the level below once that's merged", () => {
    const t = task("t")
    const bottom = task("b", { ...into("t"), ...merged })
    const level = task("l", on("b"))
    assert.strictEqual(mergeLane([t, bottom, level], level), "t")
    assert.strictEqual(mergeLane([t, task("b", into("t")), level], level), null)
  })

  it("the slot: merging and running or waiting on the user, not waiting for approval; or handed to a workflow", () => {
    assert.strictEqual(activeMerge(slotRows(merging), null, new Set())?.id, "a")
    assert.strictEqual(activeMerge(slotRows({ status: "needs_attention", merging: true }), null, new Set())?.id, "a")
    assert.isNull(activeMerge(slotRows({ ...merging, merge_approval: "pending" }), null, new Set()))
    assert.isNull(activeMerge(slotRows({ status: "needs_attention", merging: true, merge_approval: "pending" }), null, new Set()))
    // The merge handoff (HA-276): its agent said it's merged, for its workflow to move it to Done.
    const handoff = { status: "ready_for_merge" as const, merging: false }
    assert.strictEqual(activeMerge(slotRows(handoff), null, new Set(["a"]))?.id, "a")
    assert.isNull(activeMerge(slotRows(handoff), null, new Set()))
    // Another lane's merge doesn't hold this one.
    assert.isNull(activeMerge([task("t"), task("a", { ...merging, ...into("t") })], null, new Set()))
  })
})

describe("what the merge queue starts", () => {
  it("one at a time per lane, in column order; a merge into the base branch doesn't wait for one into a task", () => {
    const t = task("t")
    const a = task("a", { ...queued, ...into("t") })
    const b = task("b", { ...queued, ...into("t") })
    const o = task("o", queued)
    assert.deepStrictEqual(plan([t, a, b, o]), { ...none, start: ["a", "o"] })
    // A merging: B waits; O goes.
    assert.deepStrictEqual(plan([t, task("a", { ...merging, ...into("t") }), b, o]), { ...none, start: ["o"] })
    // A done: B goes.
    assert.deepStrictEqual(plan([t, task("a", { ...into("t"), ...merged }), b]), { ...none, start: ["b"] })
    // Column order, not age.
    assert.deepStrictEqual(plan([task("c", { ...queued, position: 1 }), task("d", { ...queued, position: 0 })]), { ...none, start: ["d"] })
  })

  it("a merge that needs changes lets the queue go, and rejoins it at the back", () => {
    // A merging; B behind it.
    const b = task("b", { ...queued, position: 2 })
    assert.deepStrictEqual(plan([task("a", { ...merging, position: 1 }), b]), none)
    // A steps out (In progress, remerge): B merges meanwhile.
    assert.deepStrictEqual(plan([task("a", { status: "in_progress", remerge: true, running: true, position: 1 }), b]), { ...none, start: ["b"] })
    // Waiting on the user while out, it holds nothing.
    assert.deepStrictEqual(plan([task("a", { status: "needs_attention", remerge: true, position: 1 }), b]), { ...none, start: ["b"] })
    // Back at the end of the queue, behind B.
    assert.deepStrictEqual(plan([task("a", { ...queued, position: 3 }), task("b", { ...merging, position: 2 })]), none)
    assert.deepStrictEqual(
      queuedMerges([task("a", { ...queued, position: 3 }), b], null, false).map((t) => t.id),
      ["b", "a"],
    )
  })

  it("a merge waiting on the user holds its lane; one out of usage keeps its place", () => {
    const b = task("b", queued)
    assert.deepStrictEqual(plan([task("a", { status: "needs_attention", merging: true, attention_reason: "Which way?" }), b]), none)
    assert.deepStrictEqual(plan([task("a", { status: "needs_attention", merging: true, limit_reset_at: AT }), b]), none)
  })

  it("an archived project's merges wait until it's unarchived", () => {
    assert.deepStrictEqual(plan([task("a", queued)], { archived: true }), none)
  })

  it("a merge needing approval is summarised whatever the slot, and out of the queue meanwhile; approved, it merges", () => {
    const rows = [task("a", merging), task("b", queued)]
    assert.deepStrictEqual(plan(rows, { approvalRequired: true }), { ...none, summarise: ["b"] })
    // Being summarised (pending), it neither holds the lane nor waits in it.
    assert.deepStrictEqual(
      plan([task("b", { ...merging, merge_approval: "pending" }), task("c", { ...queued, merge_approval: "approved" })], { approvalRequired: true }),
      {
        ...none,
        start: ["c"],
      },
    )
    assert.deepStrictEqual(plan([task("b", { ...queued, merge_approval: "approved" })], { approvalRequired: true }), { ...none, start: ["b"] })
    // A merge already under way when the setting was turned on carries on.
    assert.deepStrictEqual(plan([task("b", { ...queued, merge_approval: "approved" })], { approvalRequired: false }), { ...none, start: ["b"] })
  })

  it("closing or deleting the target holds the tasks merging into it, out of the queue", () => {
    const a = task("a", { ...queued, ...into("t") })
    assert.deepStrictEqual(plan([task("t", closed), a]), none)
    assert.deepStrictEqual(plan([a]), none)
    assert.strictEqual(heldReasonOf([task("t", closed), a], a), "X-t, which this task merges into, was closed without being merged: choose where it merges now")
    assert.strictEqual(heldReasonOf([a], a), "The task this one merges into was deleted: choose where it merges now")
    // A chain whose last target is closed holds those reaching it.
    const x = task("x", { ...queued, ...into("b") })
    assert.strictEqual(
      heldReasonOf([task("c", closed), task("b", { ...into("c"), ...merged }), x], x),
      "X-c, which this task merges into, was closed without being merged: choose where it merges now",
    )
    // Merged, it merges where that went.
    assert.deepStrictEqual(plan([task("t", merged), a]), { ...none, start: ["a"] })
  })

  it("a stack level waits for the level below, then for its restack, and then merges in its lane", () => {
    assert.strictEqual(stackState([task("b"), stackLevel()], stackLevel()), "open")
    assert.deepStrictEqual(plan([task("b"), stackLevel()]), none)
    assert.deepStrictEqual(plan([task("b", merged), stackLevel({ restack: "due" })]), none)
    assert.deepStrictEqual(plan([task("b", merged), stackLevel({ restack: "conflict" })]), none)
    assert.deepStrictEqual(plan([task("b", merged), stackLevel()]), { ...none, start: ["l"] })
    // Closed or deleted below: held, with the reason a level is given.
    assert.deepStrictEqual(plan([task("b", closed), stackLevel()]), none)
    assert.strictEqual(
      heldReasonOf([task("b", closed), stackLevel()], stackLevel()),
      "X-b, which this task lands after, was closed without being merged: choose where it merges now",
    )
    assert.strictEqual(heldReasonOf([stackLevel()], stackLevel()), "The task this one lands after was deleted: choose where it merges now")
  })
})

describe("a stack merging as one run", () => {
  const run = "run1"
  const bottom = (over: Partial<Task> = {}) => task("a", { ...queued, stack_run: run, position: 5, ...over })
  const middle = (over: Partial<Task> = {}) => task("b", { ...queued, ...on("a"), stack_run: run, position: 6, ...over })
  const top = (over: Partial<Task> = {}) => task("c", { ...queued, ...on("b"), stack_run: run, position: 7, ...over })
  const other = task("o", { ...queued, position: 1 })

  it("merges bottom first with nothing between its levels", () => {
    // Before the run starts, the queue goes in column order: O first.
    assert.deepStrictEqual(plan([other, bottom(), middle(), top()]), { ...none, start: ["o"] })
    // Under way (its bottom merging), it holds the lane.
    assert.deepStrictEqual(plan([task("o", { ...queued, position: 1 }), bottom({ running: true })]), none)
    // Its bottom merged, the next level is restacked, then merges ahead of O.
    assert.deepStrictEqual(plan([other, bottom(merged), middle({ restack: "due" }), top()]), none)
    assert.strictEqual(stackRunLanes([other, bottom(merged), middle({ restack: "due" }), top()]).get(""), run)
    assert.deepStrictEqual(plan([other, bottom(merged), middle(), top()]), { ...none, start: ["b"] })
    // Every level merged: the run is over, and its levels leave it quietly.
    assert.deepStrictEqual(plan([other, bottom(merged), middle(merged), top(merged)]), { leaveRun: ["a", "b", "c"], summarise: [], start: ["o"] })
  })

  it("a level that steps out, is denied or can't be restacked takes the levels above out of the run and frees the lane", () => {
    // B stepped out (In progress, out of the run by the task's rules): C leaves the run, said; O merges.
    const rows = [other, bottom(merged), middle({ status: "in_progress", merging: false, remerge: true, stack_run: null }), top()]
    // A merged and C out: nothing of the run is left to merge, so it is over (A leaves it quietly).
    assert.deepStrictEqual(settleStackRuns(rows), [
      { id: TaskId.make("a"), said: false },
      { id: TaskId.make("c"), said: true },
    ])
    assert.deepStrictEqual(plan(rows), { leaveRun: ["a", "c!"], summarise: [], start: ["o"] })
  })

  it("its levels are all summarised for approval before the first merges; it starts once none is pending", () => {
    const rows = [bottom(), middle(), top()]
    assert.deepStrictEqual(plan(rows, { approvalRequired: true }), { ...none, summarise: ["b", "c", "a"] })
    const approved = { merge_approval: "approved" as const }
    const waiting = [bottom(approved), middle({ merge_approval: "pending", status: "needs_attention" }), top(approved)]
    assert.isTrue(awaitsApprovals(waiting, bottom(approved), true))
    assert.deepStrictEqual(plan(waiting, { approvalRequired: true }), none)
    assert.deepStrictEqual(plan([bottom(approved), middle(approved), top(approved)], { approvalRequired: true }), { ...none, start: ["a"] })
  })
})

describe("stacks", () => {
  it("a stack is its bottom and everything landing after it; its main line follows GitHub's stack, else the lowest number", () => {
    const a = task("a")
    const b = task("b", on("a"))
    const c = task("c", on("b"))
    const d = task("d", { ...on("b"), github_stack: 4 })
    const rows = [a, b, c, d]
    assert.deepStrictEqual(
      stackOf(rows, c)?.levels.map((t) => t.id),
      ["a", "b", "c", "d"],
    )
    assert.strictEqual(stackOf(rows, d)?.bottom.id, "a")
    assert.deepStrictEqual(
      stackLine(rows, c).map((t) => t.id),
      ["a", "b", "d"],
    )
    assert.deepStrictEqual(
      stackLine([a, b, c], a).map((t) => t.id),
      ["a", "b", "c"],
    )
    // One merging into another task isn't a level.
    assert.isNull(stackOf([a, task("m", into("a"))], a))
    assert.deepStrictEqual(
      stackLine([a], a).map((t) => t.id),
      ["a"],
    )
  })
})
