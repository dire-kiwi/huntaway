import { assert, describe, it } from "@effect/vitest"
import { TaskId } from "@huntaway/contracts"
import type { Status } from "@huntaway/contracts"
import type { FinishDecision } from "./finish.ts"
import { awaitsLead, decideFollowers, isLead, leadFinished, takesGrant } from "./sets.ts"
import type { FollowerFacts } from "./sets.ts"

// A set's lead's runs (HE-118): which followers a run is given, and what its end does with them, as tables.

const LEAD = TaskId.make("lead")

type Decision = Pick<FinishDecision, "columns" | "review" | "workDone">
const ends: ReadonlyArray<readonly [string, Decision, boolean]> = [
  ["to In review", { columns: { running: false, status: "in_review" }, review: false, workDone: false }, true],
  ["held in In progress for its review (HE-66)", { columns: { running: false, status: "in_progress" }, review: true, workDone: false }, true],
  ["handed to its workflow's column", { columns: { running: false }, review: false, workDone: true }, true],
  ["a question, a failure or a stop", { columns: { running: false, status: "needs_attention" }, review: false, workDone: false }, false],
  ["held in In progress to finish its todo list", { columns: { running: false }, review: false, workDone: false }, false],
  ["back in the merge queue", { columns: { running: false, status: "ready_for_merge" }, review: false, workDone: false }, false],
  ["a compaction", { columns: { running: false }, review: false, workDone: false }, false],
]

const follower = (id: string, status: Status, work: boolean, running = false): FollowerFacts => ({
  task: { id: TaskId.make(id), kind: "task", lead_id: LEAD, status, running },
  work,
})

describe("a set's lead's run", () => {
  it("leads when it has the set's branch and no lead; a follower waits for it in To do with no run of its own", () => {
    assert.isTrue(isLead({ kind: "task", lead_id: null, set_branch: "ia/api-1-x" }))
    assert.isFalse(isLead({ kind: "task", lead_id: LEAD, set_branch: "ia/api-1-x" }))
    assert.isFalse(isLead({ kind: "task", lead_id: null, set_branch: null }))
    assert.isFalse(isLead({ kind: "review", lead_id: null, set_branch: "ia/api-1-x" }))
    const f = { kind: "task" as const, lead_id: LEAD, status: "todo" as Status, running: false, worktree_state: "ready" as const, worktree_path: "/w/1" }
    assert.deepStrictEqual(
      [f, { ...f, running: true }, { ...f, status: "in_review" as Status }, { ...f, worktree_state: "error" as const }, { ...f, lead_id: null }].map((t) => [
        awaitsLead(t),
        takesGrant(t),
      ]),
      [
        [true, true],
        [false, false],
        [false, false],
        [true, false],
        [false, false],
      ],
    )
  })

  it("finishes its work wherever it would have gone to In review before HE-66's hold", () => {
    for (const [name, decision, finished] of ends) assert.strictEqual(leadFinished(decision), finished, name)
  })

  it("moves the followers waiting for it on their work, only when it ends with its work finished", () => {
    const followers = [
      follower("commits", "todo", true),
      // An agent often leaves its edits uncommitted: `hasWorkToMerge` counts them, and they're the set's work too.
      follower("uncommitted", "todo", true),
      follower("nothing", "todo", false),
      // Past To do, or with a run of its own: its own run's end moves it.
      follower("reviewed", "in_review", true),
      follower("own run", "todo", true, true),
      follower("closed", "done", false),
    ]
    for (const [name, decision, finished] of ends) {
      assert.deepStrictEqual(
        decideFollowers(decision, followers),
        finished
          ? [
              { _tag: "Review", task: TaskId.make("commits") },
              { _tag: "Review", task: TaskId.make("uncommitted") },
              { _tag: "Close", task: TaskId.make("nothing") },
            ]
          : [],
        name,
      )
    }
    // Each later run that ends with its work finished decides again, for those still waiting.
    assert.deepStrictEqual(decideFollowers(ends[0]?.[1] ?? { columns: { running: false }, review: false, workDone: false }, []), [])
  })
})
