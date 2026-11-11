import { Context, Effect, Layer, Ref, Result, Schema } from "effect"
import type { QuestionOption, QuestionRequest, RequestResolution, Task, TaskId } from "@huntaway/contracts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"

// Questions agents ask with the board's `request_user_input` (docs/plan/07-agents.md, Permissions, questions,
// approvals; docs/plan/inventory/03-mcp.md 2.7; the old mcp/questions.ts): the question, and the options to pick from
// if the agent gave them, as a card in the thread. The agent ends its turn after asking, so a question isn't waited on
// like a permission prompt: it stays answerable after the run ends, and answering it sends the user's message that
// resumes the agent. A reply typed in the thread instead settles it too.
//
// A card is a question request in the thread (`legacy:<n>`, one question with id `q`), its metadata the card as the
// agent gave it with the call that asked (`call_id`). The request is the card's one record: open, it's pending; its
// resolution says how it was settled (`answer`: answered, with the picks and the text in `answers.q`; `cancel`: replied
// in the thread, replaced, or expired, its message says which).

/** The task's thread has no board question by that id. */
export class QuestionNotFound extends Schema.TaggedError<QuestionNotFound, { readonly brand: unique symbol }>()("QuestionNotFound", {
  task_id: Schema.String,
  request_id: Schema.String,
}) {}

/** The question can't be answered from its card any more: it has been answered (or settled), or the conversation moved on. */
export class QuestionClosed extends Schema.TaggedError<QuestionClosed, { readonly brand: unique symbol }>()("QuestionClosed", {
  reason: Schema.Literals(["answered", "moved_on"]),
  detail: Schema.String,
}) {}

/** The answer doesn't fit the question: an option it doesn't have, more than one where it takes one, nothing. */
export class AnswerInvalid extends Schema.TaggedError<AnswerInvalid, { readonly brand: unique symbol }>()("AnswerInvalid", {
  reason: Schema.String,
}) {}

/**
 * The merge approval card's answer can't be acted on (4.7, `MergeGate.decide`): the task isn't waiting for its merge to
 * be approved any more (`not_pending`), or its agent is still running (`agent_running`).
 */
export class ApprovalRefused extends Schema.TaggedError<ApprovalRefused, { readonly brand: unique symbol }>()("ApprovalRefused", {
  reason: Schema.Literals(["not_pending", "agent_running"]),
  detail: Schema.String,
}) {}

/**
 * What decides a merge from its approval card (the merge area's `MergeGate.decide`, registered when its layer is built:
 * the merge area is above this one). `approve`: the user picked Approve.
 */
export type MergeDecider = (task: TaskId, approve: boolean) => Effect.Effect<Task, TaskNotFound | ApprovalRefused>

/** The merge approval card's options (huntaway's review/merge_gate.ts `APPROVE`, `DENY`). */
export const APPROVE = "Approve"
export const DENY = "Deny"

/** The user's answer from a card: the options picked, by label, and what they typed. */
export interface Answer {
  readonly choices?: ReadonlyArray<string> | undefined
  readonly text?: string | null | undefined
}

/** `answer` checked against the card's question: the picks (trimmed, once each) and the text (trimmed, null for none). */
export const checkAnswer = (
  q: QuestionRequest["questions"][number],
  answer: Answer,
): Result.Result<{ readonly choices: ReadonlyArray<string>; readonly text: string | null }, string> => {
  const options = (q.options ?? []).map((o) => o.label)
  const choices: Array<string> = []
  for (const raw of answer.choices ?? []) {
    const c = raw.trim()
    if (!options.includes(c)) return Result.fail(`"${c}" isn't one of the question's options`)
    if (!choices.includes(c)) choices.push(c)
  }
  const typed = answer.text?.trim() ?? ""
  const text = typed === "" ? null : typed
  if (text !== null && options.length > 0 && q.allow_other === false) return Result.fail("this question takes one of its options, not an answer of your own")
  const picked = choices.length + (text === null ? 0 : 1)
  if (picked === 0) return Result.fail("pick an option or write an answer")
  if (picked > 1 && q.multi_select !== true) return Result.fail("this question takes one answer")
  return Result.succeed({ choices, text })
}

/** The most options a question can have: keys 1–9 pick them. */
export const MAX_OPTIONS = 9

/** The id of a board card's one question, the key of its answer. */
export const QUESTION_ID = "q"

/** A question as its card shows it. */
export interface QuestionCard {
  readonly question: string
  readonly options: ReadonlyArray<QuestionOption>
  /** More than one option can be picked. */
  readonly multi_select: boolean
  /** A free-text answer is offered besides the options. */
  readonly allow_other: boolean
}

/** What `request_user_input` was given, as its schema decoded it. */
export interface QuestionArgs {
  readonly question: string
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }> | undefined
  readonly multi_select?: boolean | undefined
  readonly allow_other?: boolean | undefined
}

/**
 * The card for `request_user_input`'s arguments, or why they're wrong: its question and options trimmed (a blank
 * description left out), whether more than one can be picked (default no), and whether a free-text answer is offered
 * besides them (default yes).
 */
export const card = (args: QuestionArgs): Result.Result<QuestionCard, string> => {
  const question = args.question.trim()
  if (question === "") return Result.fail("request_user_input needs a question")
  const options: Array<QuestionOption> = []
  for (const o of args.options ?? []) {
    const label = o.label.trim()
    if (label === "") return Result.fail("each of request_user_input's options needs a label")
    if (options.some((x) => x.label === label)) return Result.fail(`request_user_input's options must have different labels ("${label}" is there twice)`)
    const description = o.description?.trim() ?? ""
    options.push(description === "" ? { label } : { label, description })
  }
  if (options.length > MAX_OPTIONS) return Result.fail(`request_user_input takes at most ${MAX_OPTIONS} options`)
  return Result.succeed({ question, options, multi_select: args.multi_select ?? false, allow_other: args.allow_other ?? true })
}

/** Rust's `str::lines`: split on \n (dropping a \r before it), with no last empty line. */
const lines = (s: string): Array<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

/** The message that answers a question: the question, quoted, and the answer (a list for several). */
export const replyText = (question: string, choices: ReadonlyArray<string>, text: string | null): string => {
  const quoted = lines(question).map((l) => `> ${l}`.trimEnd())
  const answers = text === null ? choices : [...choices, text]
  const reply = answers.length === 1 ? (answers[0] ?? "") : answers.map((a) => `- ${a.replaceAll("\n", "\n  ")}`).join("\n")
  return `${quoted.join("\n")}\n\n${reply}`
}

/** How an open question is settled without its card being answered. */
export type Settled = "replied" | "replaced" | "expired"

/** What each way of settling a question tells the card (the cancellation's message). */
export const SETTLED: { readonly [S in Settled]: string } = {
  replied: "Answered with a message instead",
  replaced: "Replaced by a later question",
  expired: "Expired: its run ended before it was answered",
}

/** A card's question request, as it is opened in the thread. */
export const questionRequest = (c: QuestionCard, callId: string): Omit<QuestionRequest, "id" | "resolution"> => ({
  type: "question",
  questions: [
    {
      id: QUESTION_ID,
      question: c.question,
      ...(c.options.length === 0 ? {} : { options: c.options }),
      multi_select: c.multi_select,
      allow_other: c.allow_other,
    },
  ],
  metadata: { question: c.question, options: c.options, multi_select: c.multi_select, allow_other: c.allow_other, call_id: callId },
})

export interface QuestionsShape {
  /** Puts `card` in `task`'s thread for MCP call `callId`, once for the call (a call cut short by a restart runs again). */
  readonly ask: (task: TaskId, callId: string, card: QuestionCard) => Effect.Effect<void, TaskNotFound>
  /** Settles `task`'s open questions without an answer: the user replied in the thread, a later one replaced them, their run ended. */
  readonly settle: (task: TaskId, how: Settled) => Effect.Effect<void>
  /**
   * Answers the board question `requestId` of `task`'s thread from its card: the answer is sent to the agent as the
   * user's message (`replyText`), which carries the conversation on, and the thread's other open questions are settled
   * as replied. Only the first answer counts; one the message can't be sent for leaves the card open again. The task,
   * as sending a message gives it.
   */
  readonly answer: (
    task: TaskId,
    requestId: string,
    answer: Answer,
  ) => Effect.Effect<Task, TaskNotFound | QuestionNotFound | QuestionClosed | AnswerInvalid | SendRefused | ApprovalRefused>
  /**
   * 4.7: the merge area decides merges from now on. A merge approval card (`merge_approval` in its metadata) is the
   * board's own question: its answer is the decision (`decider`), not a message to the agent.
   */
  readonly onMergeApproval: (decider: MergeDecider) => Effect.Effect<void>
}

export class Questions extends Context.Service<Questions, QuestionsShape>()("huntaway-server/permissions/Questions") {
  static readonly layer = Layer.effect(
    Questions,
    Effect.gen(function* () {
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const store = yield* ThreadStore
      const tasks = yield* TaskRepo
      const runs = yield* Runs
      const decider = yield* Ref.make<MergeDecider | null>(null)

      const ask = Effect.fn("Questions.ask")(function* (task: TaskId, callId: string, c: QuestionCard) {
        if (yield* readers.asked(task, callId)) return
        yield* threads.openRequest(task, questionRequest(c, callId))
      })

      const settle = Effect.fn("Questions.settle")(function* (task: TaskId, how: Settled) {
        const resolution: RequestResolution = { outcome: "cancel", message: SETTLED[how] }
        for (const open of yield* readers.openQuestions(task)) {
          // Unless it's been answered since: the first settling wins.
          yield* threads.resolveRequest(task, open.request.id, resolution).pipe(Effect.ignore)
        }
      })

      const answer = Effect.fn("Questions.answer")(function* (task: TaskId, requestId: string, given: Answer) {
        if ((yield* tasks.get(task)) === null) return yield* new TaskNotFound({ id: task })
        const notFound = new QuestionNotFound({ task_id: task, request_id: requestId })
        const stored = yield* store.request(task, requestId)
        // A board card (an agent's own questions are answered as its prompt, `Permissions`).
        const asked = stored?.request
        if (stored === null || asked?.type !== "question" || asked.metadata?.["call_id"] === undefined) return yield* notFound
        const [q] = asked.questions
        if (asked.resolution !== undefined) return yield* new QuestionClosed({ reason: "answered", detail: "this question has been answered already" })
        if (stored.write_no !== null && (yield* readers.movedOn(task, stored.write_no))) {
          return yield* new QuestionClosed({ reason: "moved_on", detail: "the conversation has moved on since this was asked: reply in the thread instead" })
        }
        const checked = checkAnswer(q, given)
        if (Result.isFailure(checked)) return yield* new AnswerInvalid({ reason: checked.failure })
        const { choices, text } = checked.success
        // The compare and set: of two answers at once, only one is sent.
        yield* threads
          .resolveRequest(task, requestId, { outcome: "answer", answers: { [QUESTION_ID]: text === null ? choices : [...choices, text] } })
          .pipe(
            Effect.catchTag("RequestNotOpen", () => Effect.fail(new QuestionClosed({ reason: "answered", detail: "this question has been answered already" }))),
          )
        // The board's own question, whether to merge (4.7): the answer is the board's to act on.
        const decide = asked.metadata?.["merge_approval"] === true ? yield* Ref.get(decider) : null
        const acted: Effect.Effect<Task, TaskNotFound | ApprovalRefused | SendRefused> =
          decide !== null ? decide(task, choices.includes(APPROVE)) : runs.send(task, { text: replyText(q.question, choices, text), source: "user" })
        const sent = yield* acted.pipe(
          // Answerable again: its request open again, as it was.
          Effect.tapError(() => threads.openRequest(task, asked).pipe(Effect.ignore)),
        )
        // Any other question it was waiting on is settled by this reply.
        yield* settle(task, "replied")
        return sent
      })

      return Questions.of({ ask, settle, answer, onMergeApproval: (d) => Ref.set(decider, d) })
    }),
  )
}
