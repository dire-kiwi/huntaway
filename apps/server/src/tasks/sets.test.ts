import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { ProjectId, TaskId } from "@huntaway/contracts"
import type { NewTask, Task } from "@huntaway/contracts"
import { task } from "../merge/tests/rows.ts"
import { checkSet, freeBranchName, handOnSet, setBranchBase, setOf, setPenName, setWaitsFor } from "./sets.ts"

// The rules of a set of tasks across repositories (HE-117): what can be one, its branch name and its pen's.

const BASE = "ia/he-7-api-and-client"

describe("a set's branch name", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string | null]> = [
    ["nothing taken", [], BASE],
    ["other branches only", ["main", "ia/he-6-other", "ia/he-70-api-and-client"], BASE],
    ["taken", [BASE], `${BASE}-2`],
    ["taken with -2", [BASE, `${BASE}-2`], `${BASE}-3`],
    ["a folder of it taken (`a` beside `a/b`)", [`${BASE}/x`], `${BASE}-2`],
    ["a branch it would be a folder of", ["ia/he-7-api-and-client-2/deep"], BASE],
    ["one it would sit in (`a/b` beside `a`)", ["ia"], null],
    ["one that only starts the same", [`${BASE}x`, `${BASE}-2x`], BASE],
    ["taken, and -2 nests with another", [BASE, `${BASE}-2/y`], `${BASE}-3`],
    ["taken up to -49", [BASE, ...Array.from({ length: 48 }, (_, i) => `${BASE}-${i + 2}`)], `${BASE}-50`],
    ["taken up to -50", [BASE, ...Array.from({ length: 49 }, (_, i) => `${BASE}-${i + 2}`)], null],
  ]
  for (const [what, taken, expected] of cases) {
    it(`with ${what}: ${expected ?? "none"}`, () => {
      assert.strictEqual(freeBranchName(BASE, taken), expected)
    })
  }

  it("is the lead's key and its title's slug, as its own branch would be", () => {
    assert.strictEqual(setBranchBase("HE-7", "API and client!"), BASE)
    assert.strictEqual(setBranchBase("HE-7", "!!!"), "ia/he-7")
    assert.strictEqual(setBranchBase("WEB-12", "x".repeat(60)), `ia/web-12-${"x".repeat(40)}`)
  })
})

describe("a set's pen", () => {
  it("is named after its title, as a pen's name is kept and at most 60 characters", () => {
    assert.strictEqual(setPenName("  API   and client "), "API and client")
    assert.strictEqual(setPenName(`${"word ".repeat(12)}end`), "word ".repeat(12).trim())
  })
})

describe("what can be a set", () => {
  const project = ProjectId.make("p")
  const ok = { project_id: project, title: "API and client" }
  const also = ["API"]
  const refusal = (input: NewTask, others: ReadonlyArray<string> = also) => {
    const r = checkSet(input, others)
    return Result.isFailure(r) ? `${r.failure.field}: ${r.failure.reason}` : "ok"
  }
  const cases: ReadonlyArray<readonly [string, NewTask, string]> = [
    ["a task in a project", ok, "ok"],
    ["one starting from its base branch, said outright", { ...ok, start_from: "", merges_into: " " }, "ok"],
    ["a scratch task", { ...ok, task_type: "scratch" }, "also_in: a scratch task can't be a set of tasks across repositories: it has no worktree or branch"],
    [
      "a group task",
      { profile_id: undefined, group: "Shop", title: "Plan" },
      "also_in: a group task can't be a set of tasks across repositories: it plans across the group's projects, with no worktree",
    ],
    ["one in no project", { title: "Notes" }, "also_in: a set of tasks across repositories starts in a project: give project_id"],
    [
      "one without a worktree",
      { ...ok, use_worktree: false },
      "also_in: a set of tasks across repositories works in a worktree in each repository: leave use_worktree on",
    ],
    [
      "one merging into another task",
      { ...ok, merges_into: "HE-3" },
      "also_in: a set of tasks across repositories can't merge into another task: each of its tasks merges into its own project's base branch",
    ],
    [
      "one starting from elsewhere",
      { ...ok, start_from: "branch:dev" },
      "also_in: a set of tasks across repositories can't start from elsewhere: each of its worktrees starts from its own project's base branch",
    ],
    [
      "one starting from a commit",
      { ...ok, start_from: { type: "commit", commit: "abc" } },
      "also_in: a set of tasks across repositories can't start from elsewhere: each of its worktrees starts from its own project's base branch",
    ],
    [
      "one with only a description",
      { project_id: project, description: "Do it" },
      "title: a set of tasks across repositories needs a title: its tasks and its pen are named after it",
    ],
  ]
  for (const [what, input, expected] of cases) {
    it(`${what}: ${expected}`, () => {
      assert.strictEqual(refusal(input), expected)
    })
  }

  it("takes seven other projects at most", () => {
    assert.strictEqual(refusal(ok, ["A", "B", "C", "D", "E", "F", "G"]), "ok")
    assert.strictEqual(refusal(ok, ["A", "B", "C", "D", "E", "F", "G", "H"]), "also_in: a set of tasks across repositories takes 7 other projects at most")
  })
})

/** Task `id`, a follower in set A. */
const follower = (id: string, over: Partial<Task> = {}) => task(id, { lead_id: TaskId.make("a"), ...over })
const lead = (over: Partial<Task> = {}) => task("a", over)
const write = (rows: ReturnType<typeof handOnSet>) => rows.map((r) => `${r.id}→${r.lead_id ?? "null"}`)

describe("leaving a set (HE-119)", () => {
  // Lead A, followers B, C, D in the order they were made.
  const done: Partial<Task> = { status: "done", resolution: "not_done" }

  const cases: ReadonlyArray<readonly [string, ReadonlyArray<Task>, string, "deleted" | "closed", ReadonlyArray<string>]> = [
    ["the lead deleted: the next by creation leads", [lead(), follower("b"), follower("c"), follower("d")], "a", "deleted", ["b→null", "c→b", "d→b"]],
    ["the lead closed: the next leads, and the closed lead follows it", [lead(), follower("b"), follower("c")], "a", "closed", ["b→null", "c→b", "a→b"]],
    ["the next is closed: the next open one leads", [lead(), follower("b", done), follower("c"), follower("d")], "a", "deleted", ["b→c", "c→null", "d→c"]],
    ["none open, deleted: the next leads all the same", [lead(), follower("b", done), follower("c", done)], "a", "deleted", ["b→null", "c→b"]],
    ["none open, closed: it still leads", [lead(), follower("b", done)], "a", "closed", []],
    ["two left, the lead deleted: the other is an ordinary task", [lead(), follower("b")], "a", "deleted", ["b→null"]],
    ["two left, the lead closed: the other leads, the lead follows", [lead(), follower("b")], "a", "closed", ["b→null", "a→b"]],
    ["a follower deleted: nobody's changes", [lead(), follower("b"), follower("c")], "b", "deleted", []],
    ["a follower closed: nobody's changes", [lead(), follower("b")], "b", "closed", []],
    ["a task in no set", [lead()], "a", "deleted", []],
  ]
  for (const [what, set, gone, how, expected] of cases) {
    it(what, () => {
      const g = set.find((t) => t.id === gone) ?? assert.fail("no such task")
      assert.deepStrictEqual(write(handOnSet(set, g, how)), expected)
    })
  }
})

describe("what a set's merge waits for (HE-119)", () => {
  const leading = lead({ status: "ready_for_merge", merging: true })
  it("the open tasks not in Ready for merge, or waiting for approval there", () => {
    const set = [
      leading,
      follower("b", { status: "in_review" }),
      follower("c", { status: "ready_for_merge", merging: true }),
      follower("d", { status: "ready_for_merge", merging: true, merge_approval: "pending" }),
      follower("e", { status: "done", resolution: "not_done" }),
      follower("f", { status: "done", resolution: "done" }),
    ]
    assert.deepStrictEqual(
      setWaitsFor(set, leading).map((t) => t.id),
      ["b", "d"],
    )
    assert.deepStrictEqual(
      setOf([...set, task("x")], follower("c", {})).map((t) => t.id),
      ["a", "b", "c", "d", "e", "f"],
    )
    assert.deepStrictEqual(
      setOf(set, task("x")).map((t) => t.id),
      ["x"],
    )
  })
})
