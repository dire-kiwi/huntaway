import { Context, Effect, Layer, Result } from "effect"
import type { QuestionOption, QuestionRequest, RequestResolution, TaskId } from "@huntaway/contracts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"

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
}

export class Questions extends Context.Service<Questions, QuestionsShape>()("huntaway-server/permissions/Questions") {
  static readonly layer = Layer.effect(
    Questions,
    Effect.gen(function* () {
      const threads = yield* Threads
      const readers = yield* ThreadReaders

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

      return Questions.of({ ask, settle })
    }),
  )
}
