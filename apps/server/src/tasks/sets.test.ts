import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { ProjectId } from "@huntaway/contracts"
import type { NewTask } from "@huntaway/contracts"
import { checkSet, freeBranchName, setBranchBase, setPenName } from "./sets.ts"

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
