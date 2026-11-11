import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { Task, TaskId } from "@huntaway/contracts"
import { TestBoard, TestMcp, TestMcpOver, TestTools } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { agentOf, call, ok, profile } from "../mcp/tools/tests/board.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { Questions, SETTLED } from "./Questions.ts"
import type { Answer } from "./Questions.ts"

// Answering a `request_user_input` card (the old mcp/questions.test.ts's `answer` cases): the answer is checked against
// the question, the first one wins, and it is sent to the agent as the user's message through `Runs`.

const requests = (task: TaskId) =>
  Effect.map(
    Effect.flatMap(Threads, (threads) => threads.stored(task)),
    (s) => s.requests,
  )

/** The agent asks; the card's request id. */
const ask = (agent: FakeAgent, args: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    ok(yield* call(agent, "request_user_input", args))
    const all = yield* requests(agent.run.task_id)
    return all.at(-1)?.id ?? ""
  })

const answer = (task: TaskId, id: string, choices: ReadonlyArray<string>, text: string | null) =>
  Effect.flatMap(Questions, (questions) => questions.answer(task, id, { choices, text } satisfies Answer))

/** The tag of the error `effect` fails with. */
const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)

/** Whether the task was sent `text`: steered into its run, or queued for after it. */
const sent = (t: Task, text: string) => t.steering.some((s) => s.text === text) || t.queued_message === text

const noAgents = TestMcpOver().pipe(Layer.provideMerge(TestTools.layer), Layer.provideMerge(TestBoard({ noAgents: true })))

describe("Questions.answer", () => {
  it.effect("a question with options is answered from its card, once", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const task = me.run.task_id
      const id = yield* ask(me, { question: "Which colour?", options: [{ label: "Red", description: "Bold" }, { label: "Green" }] })
      assert.strictEqual(yield* failure(answer(task, id, ["Blue"], null)), "AnswerInvalid")
      assert.strictEqual(yield* failure(answer(task, id, ["Red", "Green"], null)), "AnswerInvalid")
      assert.strictEqual(yield* failure(answer(task, id, ["Red"], "and blue")), "AnswerInvalid")
      assert.strictEqual(yield* failure(answer(task, id, [], "  ")), "AnswerInvalid")
      // Not another thread's.
      const other = yield* agentOf(yield* profile("work"))
      assert.strictEqual(yield* failure(answer(other.run.task_id, id, ["Red"], null)), "QuestionNotFound")
      assert.strictEqual(yield* failure(answer(task, "legacy:999999", ["Red"], null)), "QuestionNotFound")

      const t = yield* answer(task, id, ["Red"], null)
      assert.isTrue(sent(t, "> Which colour?\n\nRed"), "the answer is sent")
      const [q] = yield* requests(task)
      assert.deepStrictEqual(q?.resolution, { outcome: "answer", answers: { q: ["Red"] } })
      // A second answer (another tab's) isn't sent.
      assert.strictEqual(yield* failure(answer(task, id, ["Green"], null)), "QuestionClosed")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("several answers, or one's own; and an answer settles the others", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const task = me.run.task_id
      let id = yield* ask(me, { question: "Which?", options: ["A", "B", "C"], multi_select: true })
      let t = yield* answer(task, id, ["C", "A", "A"], "and D,\nwith E")
      assert.isTrue(sent(t, "> Which?\n\n- C\n- A\n- and D,\n  with E"))
      // Only the options, when it doesn't take an answer of the user's own.
      id = yield* ask(me, { question: "Pick one", options: ["X"], allow_other: false })
      assert.strictEqual(yield* failure(answer(task, id, [], "Y")), "AnswerInvalid")
      // Without options, any answer.
      id = yield* ask(me, { question: "What's the URL?" })
      t = yield* answer(task, id, [], "https://example.com")
      assert.isTrue(sent(t, "> What's the URL?\n\nhttps://example.com"))
      // That settles the one it was still waiting on as well.
      assert.deepStrictEqual(
        (yield* requests(task)).map((r) => (r.resolution?.outcome === "answer" ? "answered" : r.resolution?.message)),
        ["answered", SETTLED.replied, "answered"],
      )
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("stays answerable until its answer is sent", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const task = me.run.task_id
      const id = yield* ask(me, { question: "Which?", options: ["A", "B"] })
      // The run ends, and no agent can start here: the answer can't be sent, so it can be given again.
      yield* (yield* RunRepo).end(me.run.id, Timestamp.make("2026-11-12T00:00:00.000Z"))
      assert.strictEqual(yield* failure(answer(task, id, ["A"], null)), "SendRefused")
      assert.isUndefined((yield* requests(task))[0]?.resolution)
      assert.strictEqual(yield* failure(answer(task, id, ["B"], null)), "SendRefused")
    }).pipe(Effect.provide(noAgents)),
  )

  it.effect("a question the conversation has moved past isn't answered", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const task = me.run.task_id
      const id = yield* ask(me, { question: "Which?", options: ["A", "B"] })
      // A message that doesn't settle it as the user's reply does (the board's own, say).
      yield* (yield* Threads).userMessage(task, "Merge it", { auto: true })
      assert.strictEqual(yield* failure(answer(task, id, ["A"], null)), "QuestionClosed")
      assert.isUndefined((yield* requests(task))[0]?.resolution)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a reply in the thread settles its questions, which can't be answered after", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const task = me.run.task_id
      const id = yield* ask(me, { question: "Which?", options: ["A", "B"] })
      yield* (yield* Questions).settle(task, "replied")
      assert.strictEqual((yield* requests(task))[0]?.resolution?.message, SETTLED.replied)
      assert.strictEqual(yield* failure(answer(task, id, ["A"], null)), "QuestionClosed")
    }).pipe(Effect.provide(TestMcp())),
  )
})
