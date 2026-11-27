import { assert, describe, it } from "@effect/vitest"
import type { Task } from "@huntaway/contracts"
import { mergeFailed } from "./sets.ts"
import { task } from "./tests/rows.ts"

// HE-119: which changes of a set's task are its merge failing, told to the lead's thread once others of its set merged.

const merging: Partial<Task> = { status: "ready_for_merge", merging: true, running: true }

describe("a set's task's merge failing", () => {
  const cases: ReadonlyArray<readonly [string, Partial<Task>, Partial<Task>, boolean]> = [
    [
      "its merge needs attention (a question, a failed launch)",
      merging,
      { status: "needs_attention", running: false, attention_reason: "Merge conflict" },
      true,
    ],
    ["moved out of the merge by the user", merging, { status: "in_review", merging: false, running: false }, true],
    ["closed as not done while merging", merging, { status: "done", resolution: "not_done", merging: false, running: false }, true],
    ["merged", merging, { status: "done", resolution: "done", merging: false, running: false }, false],
    // `runs/finish.ts` `mergeFinished`: the agent merged and said `finish_work`; the workflow moves it to Done.
    ["merged and handed to its project's workflow", merging, { status: "ready_for_merge", merging: false, running: false }, false],
    ["stepped out to make changes (it rejoins)", merging, { status: "in_progress", merging: false, remerge: true }, false],
    [
      "its summary ended, waiting for approval",
      { ...merging, merge_approval: "pending" },
      { status: "needs_attention", running: false, merge_approval: "pending" },
      false,
    ],
    ["already needing attention, then moved", { ...merging, status: "needs_attention", running: false }, { status: "in_review", merging: false }, false],
    ["not merging", { status: "in_review" }, { status: "needs_attention" }, false],
  ]
  for (const [what, before, after, failed] of cases) {
    it(`${what}: ${failed ? "failed" : "not a failure"}`, () => {
      const b = task("b", before)
      assert.strictEqual(mergeFailed(b, task("b", { ...before, ...after })), failed)
    })
  }
})
