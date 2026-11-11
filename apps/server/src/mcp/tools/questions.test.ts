import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { TestMcp } from "@huntaway/testing"
import { card, MAX_OPTIONS, Questions, replyText, SETTLED } from "../../permissions/Questions.ts"
import { Threads } from "../../threads/Threads.ts"
import { ASKED, ASKED_WITH_OPTIONS, FINISHED } from "./questions.ts"
import { agentOf, call, err, ok, profile } from "./tests/board.ts"

// Questions agents ask with `request_user_input`, and `finish_work` (the old mcp/questions.test.ts and the cases of
// mcp/tools/dispatch.test.ts about them). Answering a card (`Questions.answer`, the old `answer`'s cases) sends the
// user's message, which comes with `Runs` (2.5): those cases are ported with it. The reply's text is here.

const requests = (task: string) =>
  Effect.map(
    Effect.flatMap(Threads, (threads) => threads.stored(TaskId.make(task))),
    (s) => s.requests,
  )

describe("request_user_input", () => {
  it("checks what the agent asks", () => {
    assert.isTrue(Result.isFailure(card({ question: " " })))
    assert.deepStrictEqual(
      card({ question: "Which?", options: [{ label: "A" }, { label: " B ", description: " the second " }, { label: "C", description: "" }] }),
      Result.succeed({
        question: "Which?",
        options: [{ label: "A" }, { label: "B", description: "the second" }, { label: "C" }],
        multi_select: false,
        allow_other: true,
      }),
    )
    assert.isTrue(Result.isFailure(card({ question: "Which?", options: [{ label: " " }] })))
    assert.deepStrictEqual(
      card({ question: "Which?", options: [{ label: "A" }, { label: "A" }] }),
      Result.fail('request_user_input\'s options must have different labels ("A" is there twice)'),
    )
    assert.deepStrictEqual(
      card({ question: "Which?", options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: String(i) })) }),
      Result.fail("request_user_input takes at most 9 options"),
    )
    assert.deepStrictEqual(
      card({ question: "Which?", multi_select: true, allow_other: false }),
      Result.succeed({ question: "Which?", options: [], multi_select: true, allow_other: false }),
    )
  })

  it("answers as the user's message: the question quoted, then the answer or a list of them", () => {
    assert.strictEqual(replyText("Which colour?", ["Red"], null), "> Which colour?\n\nRed")
    assert.strictEqual(replyText("Which?", ["C", "A"], "and D,\nwith E"), "> Which?\n\n- C\n- A\n- and D,\n  with E")
    assert.strictEqual(replyText("What's the URL?", [], "https://example.com"), "> What's the URL?\n\nhttps://example.com")
    assert.strictEqual(replyText("Two\nlines \n", ["x"], null), "> Two\n> lines\n\nx")
  })

  it.effect("puts a card in the thread once per call, and flags the run", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const args = { question: "Which colour?", options: [{ label: "Red", description: "Bold" }, "Green"] }
      const v = ok(yield* call(me, "request_user_input", args, "c1"))
      assert.deepStrictEqual(v, { ok: true, note: ASKED_WITH_OPTIONS })
      // Run again after a restart cut it short: still one card.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE mcp_calls SET status = 'executing' WHERE id = 'c1'`.pipe(Effect.orDie)
      ok(yield* call(me, "request_user_input", args, "c1"))
      const asked = yield* requests(me.run.task_id)
      assert.strictEqual(asked.length, 1)
      const [q] = asked
      assert.strictEqual(q?.type, "question")
      assert.match(q?.id ?? "", /^legacy:\d+$/)
      assert.isUndefined(q?.resolution)
      assert.deepStrictEqual(q?.type === "question" ? q.questions : null, [
        { id: "q", question: "Which colour?", options: [{ label: "Red", description: "Bold" }, { label: "Green" }], multi_select: false, allow_other: true },
      ])
      assert.strictEqual(q?.metadata?.["call_id"], "c1")
      assert.strictEqual((yield* me.row).attention, "Which colour?")
      // Without options, the agent ends its turn with the question.
      assert.deepStrictEqual(ok(yield* call(me, "request_user_input", { question: "What's the URL?" })), { ok: true, note: ASKED })
      // What it can't be.
      assert.strictEqual(err(yield* call(me, "request_user_input", { question: " " })), "request_user_input needs a question")
      assert.include(err(yield* call(me, "request_user_input", { question: "Which?", options: Array.from({ length: 10 }, (_, i) => String(i)) })), "schema")
      assert.include(err(yield* call(me, "request_user_input", { question: "Which?", multi_select: "yes" })), "schema")
      assert.strictEqual((yield* requests(me.run.task_id)).length, 2)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a reply in the thread settles its questions", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      ok(yield* call(me, "request_user_input", { question: "Which?", options: ["A", "B"] }))
      ok(yield* call(me, "request_user_input", { question: "And?" }))
      const questions = yield* Questions
      yield* questions.settle(me.run.task_id, "replied")
      assert.deepStrictEqual(
        (yield* requests(me.run.task_id)).map((r) => r.resolution),
        [
          { outcome: "cancel", message: SETTLED.replied },
          { outcome: "cancel", message: SETTLED.replied },
        ],
      )
      // Nothing open is left to settle.
      yield* questions.settle(me.run.task_id, "replaced")
      assert.strictEqual((yield* requests(me.run.task_id)).filter((r) => r.resolution?.message === SETTLED.replaced).length, 0)
    }).pipe(Effect.provide(TestMcp())),
  )
})

describe("finish_work", () => {
  it.effect("records that the run's work is done", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      assert.isFalse((yield* me.row).finished)
      assert.deepStrictEqual(ok(yield* call(me, "finish_work", {})), { ok: true, note: FINISHED })
      assert.isTrue((yield* me.row).finished)
      // It takes no arguments.
      assert.include(err(yield* call(me, "finish_work", { done: true })), 'finish_work has no argument "done"')
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("isn't a reviewer's, nor a planner's", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE tasks SET permission_mode = 'plan' WHERE id = ${me.run.task_id}`.pipe(Effect.orDie)
      assert.include(err(yield* call(me, "finish_work", {})), "isn't available in plan mode")
      // Asking is.
      ok(yield* call(me, "request_user_input", { question: "Which?" }))
      yield* sql`UPDATE tasks SET permission_mode = NULL, kind = 'review' WHERE id = ${me.run.task_id}`.pipe(Effect.orDie)
      assert.include(err(yield* call(me, "finish_work", {})), "isn't available to reviewers")
      ok(yield* call(me, "request_user_input", { question: "Which?" }))
      assert.isFalse((yield* me.row).finished)
    }).pipe(Effect.provide(TestMcp())),
  )
})
