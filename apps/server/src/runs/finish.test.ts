import { assert, describe, it } from "@effect/vitest"
import { Timestamp } from "@huntaway/contracts"
import type { Todo } from "@huntaway/contracts"
import { APPROVAL, decideFinish, nudged, outcomeOf, PLAN_READY, todoReason } from "./finish.ts"
import type { FinishFacts } from "./finish.ts"
import { Outcome } from "./Run.ts"

// The end of a run's decision (huntaway's runner/output.ts `on_exit` and `finish`, runner/todos.ts), case by case, first
// match wins. The cases that need merges (M4), workflows (6.6), reviews (5.x) or a plan's checkpoints (M4) are here as
// facts that are false until those areas give them.

const facts = (over: Partial<FinishFacts> = {}): FinishFacts => ({
  outcome: Outcome.ok,
  run: { kind: "prompt", attention: null, finished: false },
  task: {
    kind: "task",
    status: "in_progress",
    merging: false,
    remerge: false,
    merge_approval: null,
    task_type: null,
    project_id: null,
    todos: [],
    limit_reset_at: null,
  },
  limitAhead: false,
  limitWait: false,
  configName: "Work",
  mergeHeld: null,
  mergesToDone: false,
  finishDue: null,
  planOnly: false,
  nudged: false,
  endOfMergeQueue: 9,
  ...over,
})
const task = facts().task
const todo = (text: string, status: Todo["status"]): Todo => ({ text, status })

describe("outcomeOf", () => {
  it("a stop is cancelled; the last turn's error fails it; exit 0 after a result is ok; else how it exited, with err.log", () => {
    const run = { stop: "none", result_error: null, saw_result: true } as const
    assert.deepStrictEqual(outcomeOf({ ...run, stop: "interrupted" }, { code: 0, signal: null }, ""), Outcome.cancelled)
    assert.deepStrictEqual(outcomeOf({ ...run, result_error: "boom" }, { code: 0, signal: null }, ""), Outcome.failed("boom"))
    assert.deepStrictEqual(outcomeOf(run, { code: 0, signal: null }, ""), Outcome.ok)
    assert.deepStrictEqual(outcomeOf({ ...run, saw_result: false }, { code: 0, signal: null }, ""), Outcome.failed("the agent exited with code 0"))
    assert.deepStrictEqual(outcomeOf(run, { code: null, signal: 9 }, " oops \n"), Outcome.failed("the agent was killed by signal 9\noops"))
    assert.deepStrictEqual(
      outcomeOf(run, { code: null, signal: null, error: "the run's folder was removed" }, ""),
      Outcome.failed("the run's folder was removed"),
    )
  })
})

describe("decideFinish", () => {
  it("cancelled, failed, a question, done", () => {
    const stopped = decideFinish(facts({ outcome: Outcome.cancelled }))
    assert.deepStrictEqual(stopped.columns, { running: false, attention_reason: "Stopped by user", status: "needs_attention" })
    assert.deepStrictEqual(stopped.notices, [{ level: "warning", text: "Run stopped" }])
    const failed = decideFinish(facts({ outcome: Outcome.failed("no login\nmore") }))
    assert.deepStrictEqual(failed.columns, { running: false, attention_reason: "Run failed: no login", status: "needs_attention" })
    assert.deepStrictEqual(failed.notices, [{ level: "error", text: "Run failed", detail: "no login\nmore" }])
    assert.deepStrictEqual(decideFinish(facts({ run: { kind: "prompt", attention: "Which one?", finished: false } })).columns, {
      running: false,
      attention_reason: "Which one?",
      status: "needs_attention",
    })
    assert.deepStrictEqual(decideFinish(facts({ task: { ...task, status: "done" } })).columns, { running: false, attention_reason: null })
  })

  it("out of usage: waits for the reset (the profile's setting) or needs attention, and keeps what is queued", () => {
    const out = {
      outcome: Outcome.failed("You've hit your limit · resets 5pm"),
      limitAhead: true,
      task: { ...task, limit_reset_at: Timestamp.make("2026-11-12T17:00:00.000Z") },
    } as const
    const waits = decideFinish(facts({ ...out, limitWait: true }))
    assert.deepStrictEqual(waits.columns, { running: false, attention_reason: null, waiting: true, status: "in_progress" })
    assert.deepStrictEqual(
      waits.notices.map((n) => n.text),
      ["Work is out of usage", "Waiting for Work's usage limit to reset"],
    )
    assert.isFalse(waits.sendQueued)
    assert.deepStrictEqual(decideFinish(facts(out)).columns, {
      running: false,
      attention_reason: "You've hit your limit · resets 5pm",
      status: "needs_attention",
    })
    // A merging task doesn't wait.
    assert.strictEqual(decideFinish(facts({ ...out, limitWait: true, task: { ...out.task, merging: true } })).columns.status, "needs_attention")
  })

  it("merging: the approval, a merge said to be finished, one not; stepping out rejoins the queue at its end", () => {
    const merging = { ...task, merging: true }
    assert.strictEqual(decideFinish(facts({ task: { ...merging, merge_approval: "pending" } })).columns.attention_reason, APPROVAL)
    assert.deepStrictEqual(decideFinish(facts({ task: merging, mergesToDone: true, run: { kind: "prompt", attention: null, finished: true } })).columns, {
      running: false,
      attention_reason: null,
      merging: false,
    })
    assert.strictEqual(decideFinish(facts({ task: merging })).columns.attention_reason, "The agent finished without marking the task merged")
    const back = decideFinish(facts({ task: { ...task, remerge: true } }))
    assert.deepStrictEqual(back.columns, { running: false, attention_reason: null, status: "ready_for_merge", merging: true, remerge: false, position: 9 })
    assert.deepStrictEqual(back.notices, [{ level: "info", text: "Back in the merge queue" }])
    // Held until the user says where it merges now: out of the merge queue.
    assert.deepStrictEqual(decideFinish(facts({ task: merging, mergeHeld: "WEB-3 was closed: choose where it merges now" })).columns, {
      running: false,
      attention_reason: "WEB-3 was closed: choose where it merges now",
      merging: false,
      remerge: false,
      merge_approval: null,
      status: "needs_attention",
    })
  })

  it("the assistant and the pens wait for the next message, a routine is done, a task goes to review or its plan waits", () => {
    assert.strictEqual(decideFinish(facts({ task: { ...task, task_type: "assistant" } })).columns.status, "todo")
    assert.strictEqual(decideFinish(facts({ task: { ...task, task_type: "pen" } })).columns.status, "todo")
    assert.strictEqual(decideFinish(facts({ task: { ...task, task_type: "routine" } })).columns.status, "done")
    assert.strictEqual(decideFinish(facts()).columns.status, "in_review")
    assert.deepStrictEqual(decideFinish(facts({ planOnly: true })).columns, { running: false, attention_reason: PLAN_READY, status: "needs_attention" })
    // A review thread's run only stops running: its outcome is the review's.
    assert.deepStrictEqual(decideFinish(facts({ task: { ...task, kind: "review" } })).columns, { running: false, attention_reason: null })
  })

  it("an unfinished todo list holds the task in progress and asks its agent once, then it needs attention", () => {
    const todos = [todo("one", "completed"), todo("two", "in_progress"), todo("three", "pending")]
    const first = decideFinish(facts({ task: { ...task, todos } }))
    assert.deepStrictEqual(first.columns, { running: false, attention_reason: null })
    assert.deepStrictEqual(
      first.nudge?.map((x) => x.text),
      ["two", "three"],
    )
    const again = decideFinish(facts({ task: { ...task, todos }, nudged: true }))
    assert.deepStrictEqual(again.columns, {
      running: false,
      attention_reason: todoReason([todos[1] ?? todo("", "pending"), todos[2] ?? todo("", "pending")]),
      status: "needs_attention",
    })
    assert.isNull(again.nudge)
    // Not the assistant's, and not a run that needs attention anyway.
    assert.isNull(decideFinish(facts({ task: { ...task, todos, task_type: "assistant" } })).nudge)
    assert.isNull(decideFinish(facts({ task: { ...task, todos }, outcome: Outcome.cancelled })).nudge)
    assert.isTrue(nudged({ text: "Your todo list still has unfinished items, so…", auto: true }))
    assert.isFalse(nudged({ text: "Your todo list still has unfinished items", auto: false }))
  })

  it("a compaction never moves the card, and says when it stopped or failed", () => {
    const compact = { kind: "compact", attention: null, finished: false } as const
    assert.deepStrictEqual(decideFinish(facts({ run: compact })), {
      notices: [],
      columns: { running: false },
      sendQueued: true,
      nudge: null,
      workDone: false,
      mergeFinished: false,
    })
    assert.deepStrictEqual(decideFinish(facts({ run: compact, outcome: Outcome.failed("x") })).notices, [
      { level: "error", text: "Compacting failed", detail: "x" },
    ])
    assert.deepStrictEqual(decideFinish(facts({ run: compact, outcome: Outcome.cancelled })).notices, [{ level: "warning", text: "Compacting stopped" }])
  })
})
