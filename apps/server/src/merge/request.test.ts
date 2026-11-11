import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { TaskId } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { mergeRequestText, stackedMerge } from "./request.ts"
import { task as row } from "./tests/rows.ts"

// What a merge request says (huntaway's agent/runner/merge.ts `request_merge`, `into_merge`, `stacked_merge`): the
// prompt cases of the old agent/runner/merge.test.ts, api/incoming.test.ts and api/stack_merge.test.ts.

const task = (n: number, over: Partial<Task> = {}): Task =>
  row(String.fromCharCode(96 + n), {
    id: TaskId.make(`t${n}`),
    key: `WEB-${n}`,
    title: `Task ${n}`,
    branch: `ia/web-${n}`,
    ...over,
  })

const text = (rows: ReadonlyArray<Task>, t: Task, base: string | null = "main") => {
  const r = mergeRequestText(rows, { task: t, project: null, base })
  return Result.isSuccess(r) ? r.success : `failed: ${r.failure}`
}

describe("a merge request", () => {
  it("asks to merge the branch, with the project's instructions, how to step out and how to say it's merged", () => {
    const t = task(1, { status: "ready_for_merge", merging: true })
    const said = text([t], t)
    assert.isTrue(said.startsWith('The user moved this task to "Ready for merge". Merge branch `ia/web-1` into `main`.\n\n'), said)
    assert.include(
      said,
      "If you can't merge, call `request_user_input` explaining why. Once it is merged, call `update_task` to set this task's status to `done`.",
    )
    assert.include(said, "with `remerge` true")
    assert.include(text([t], task(1, { merge_approval: "approved" })), "The user approved the merge.")
  })

  it("a stacked task targets the branch it stacks on until that task is merged, then where it went", () => {
    const first = task(1)
    const second = task(2, { start_from: { type: "task", task_id: TaskId.make("t1") }, base_branch: "ia/web-1" })
    const failed = stackedMerge([first, second], second, "ia/web-1")
    assert.isTrue(Result.isFailure(failed) && failed.failure.startsWith("WEB-1, which this task lands after, isn't merged yet"))
    const merged = task(1, { status: "done", resolution: "done" })
    const said = stackedMerge([merged, second], second, "main")
    assert.include(Result.isSuccess(said) ? said.success : "", "if its pull request still targets `ia/web-1`, change its base to `main` first")
    // Restacked by the board onto where that went: told so (and by GitHub, to merge it with pr_merge).
    const restacked = task(2, { start_from: { type: "task", task_id: TaskId.make("t1") }, base_branch: "main", github_stack: 7 })
    const told = stackedMerge([merged, restacked], restacked, "main")
    assert.include(Result.isSuccess(told) ? told.success : "", "its branch was restacked onto `main` (by GitHub")
    // Closed without being merged: held.
    const closed = stackedMerge([task(1, { status: "done", resolution: "wont_fix" }), second], second, "ia/web-1")
    assert.isTrue(Result.isFailure(closed) && closed.failure.endsWith("was closed without being merged: choose where it merges now"))
    // Not stacked: nothing more.
    assert.deepStrictEqual(stackedMerge([first], first, "main"), Result.succeed(""))
  })

  it("a task merging into another merges onto its branch while it's open, and where it went once it's merged", () => {
    const target = task(1)
    const a = task(2, { merges_into: TaskId.make("t1"), base_branch: "ia/web-1" })
    assert.include(text([target, a], a, "ia/web-1"), 'This task merges into WEB-1 ("Task 1", in review): its work goes onto WEB-1\'s branch `ia/web-1`')
    assert.include(
      text([task(1, { status: "done", resolution: "done" }), a], a),
      "This task merges into WEB-1, which is merged already, so merge it into `main`",
    )
    assert.strictEqual(
      text([task(1, { status: "done", resolution: "not_done" }), a], a),
      "failed: the task it merges into was closed without being merged, or deleted: choose where it merges now",
    )
  })

  it("a target's merge asks about the tasks merging into it that aren't done; once they are, to bring its branch up to date", () => {
    const target = task(1, { status: "ready_for_merge", merging: true })
    const a = task(2, { merges_into: TaskId.make("t1"), status: "todo" })
    const said = text([target, a], target)
    assert.include(said, "Other tasks merge into this one's branch, and some of them aren't done yet: WEB-2 (Task 2, todo). Ask the user")
    const done = text([target, task(2, { merges_into: TaskId.make("t1"), status: "done", resolution: "done" })], target)
    assert.include(done, "Other tasks were merged into this one's branch: bring it up to date first")
  })

  it("a task sent elsewhere from a closed target is asked about its commits", () => {
    const b = task(2, { carries: { key: "WEB-1", commit: "abc123" } })
    const said = text([b], b, "master")
    assert.include(said, "This task's branch started on top of WEB-1's, which was closed without being merged, so it may still have WEB-1's commits")
    assert.include(said, "before commit `abc123`")
    assert.include(said, "`git log master..ia/web-2`")
    assert.include(said, "(`git rebase --onto master abc123`, then force-push the branch)")
  })

  it("a level of a stack merging as one run is told how many levels follow it", () => {
    const run = { stack_run: "r1" }
    const a = task(1, run)
    const b = task(2, { ...run, start_from: { type: "task", task_id: TaskId.make("t1") }, base_branch: "ia/web-1" })
    const c = task(3, { ...run, start_from: { type: "task", task_id: TaskId.make("t2") }, base_branch: "ia/web-2" })
    assert.include(text([a, b, c], a), "The user is merging this task's whole stack at once: the 2 levels above it merge right after this one")
    assert.include(text([a, b], a), "the level above it merges right after this one")
  })
})
