import { Effect, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { card, MAX_OPTIONS, Questions } from "../../permissions/Questions.ts"
import { RunRepo } from "../../runs/RunRepo.ts"
import { ForPlanning, ForReviewers, Rerunnable, ToolError } from "../tool.ts"
import { threadTool } from "./common.ts"

// The board's tools for asking the user and finishing a column's work (docs/plan/inventory/03-mcp.md 2.5 and 2.7; the
// old mcp/schemas/waiting.ts `ask_tools` and mcp/tools/dispatch.ts): `request_user_input` and `finish_work`. Both
// record what the run said (`runs.attention`, `runs.finished`) for the end of the run to read.

export const RequestUserInput = Tool.make("request_user_input", {
  description:
    "Flag this task as 'Needs attention' because you need an answer, decision or information from the user. " +
    "The board shows your question as a card in the thread. When the possible answers are known (a choice between approaches, " +
    "yes or no, which of several things to do), give them as options: the user then answers with a click (or keys 1-9), and " +
    "can still write their own answer unless allow_other is false. After calling it, end your turn with the question (and " +
    "what the user needs to know to answer it); the user's reply (the options they picked, or what they wrote) will resume " +
    `the conversation. Up to ${MAX_OPTIONS} options.`,
  parameters: Schema.Struct({
    question: Schema.String.annotate({
      description: "The question, short enough to show on the task's card (e.g. 'Which database should the cache use?')",
    }),
    options: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          label: Schema.String.annotate({ description: "The answer, in a few words" }),
          description: Schema.optionalKey(Schema.String.annotate({ description: "What picking it means, or its trade-offs" })),
        }),
      )
        .check(Schema.isMaxLength(MAX_OPTIONS))
        .annotate({ description: "The answers to pick from, if they're known; put the one you recommend first" }),
    ),
    multi_select: Schema.optionalKey(Schema.Boolean.annotate({ description: "Let the user pick more than one option (default false)" })),
    allow_other: Schema.optionalKey(Schema.Boolean.annotate({ description: "Offer a free-text answer besides the options (default true)" })),
  }),
  success: Schema.Struct({ ok: Schema.Boolean, note: Schema.String }),
})
  // It records its card once per call, so a call cut short by a restart runs again.
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const FinishWork = Tool.make("finish_work", {
  description:
    "Say that the work you were asked for in the task's current column is complete, when its prompt asks you to (a project's workflow " +
    "can wait for this rather than for your turn to end). Call it once the work is done, then end your turn with a summary. Don't call it " +
    "when you're stopping for another reason, such as to ask the user something with request_user_input.",
  success: Schema.Struct({ ok: Schema.Boolean, note: Schema.String }),
}).annotate(Rerunnable, true)

/** An option given as a plain string is taken as its label, as the old tool took it. */
const labelsAsOptions = (args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const options = args["options"]
  if (!Array.isArray(options)) return args
  return { ...args, options: options.map((o: unknown) => (typeof o === "string" ? { label: o } : o)) }
}

/** What `request_user_input` tells the agent. */
export const ASKED_WITH_OPTIONS =
  "The user will be notified and shown your question with its options. End your turn now; their answer (the options " +
  "they picked, or what they wrote) comes as their next message."
export const ASKED = "The user will be notified. End your turn now with your question."
export const FINISHED = "Recorded that the work is done. End your turn now with a summary of what you did."

/** The asking tools' handlers, in the order runs are shown them. */
export const questionTools = Effect.gen(function* () {
  const questions = yield* Questions
  const runs = yield* RunRepo

  const requestUserInput = threadTool(
    RequestUserInput,
    (params, caller) =>
      Effect.gen(function* () {
        const asked = card(params)
        if (Result.isFailure(asked)) return yield* ToolError.other(asked.failure)
        // Read when the run ends: it ends in Needs attention with the question.
        yield* runs.update(caller.run.id, { attention: asked.success.question })
        yield* questions
          .ask(caller.task.id, caller.call_id, asked.success)
          .pipe(Effect.catchTag("TaskNotFound", () => Effect.fail(ToolError.other("unknown task"))))
        return { ok: true, note: asked.success.options.length > 0 ? ASKED_WITH_OPTIONS : ASKED }
      }),
    { prepare: labelsAsOptions },
  )

  const finishWork = threadTool(FinishWork, (_params, caller) =>
    // Read when the run ends, and cleared when another turn starts in it.
    Effect.as(runs.update(caller.run.id, { finished: true }), { ok: true, note: FINISHED }),
  )

  return { requestUserInput, finishWork }
})
