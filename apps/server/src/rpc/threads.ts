import { Effect, Stream } from "effect"
import { Conflict, Invalid, NotFound, ThreadRpcs } from "@huntaway/contracts"
import { Questions } from "../permissions/Questions.ts"
import { Threads } from "../threads/Threads.ts"
import { sendRefused } from "./tasks.ts"

const taskNotFound = (e: { readonly id: string }) => new NotFound({ what: "task", id: e.id })

export const ThreadHandlers = ThreadRpcs.toLayer(
  Effect.gen(function* () {
    const threads = yield* Threads
    const questions = yield* Questions
    return ThreadRpcs.of({
      "threads.watch": ({ task_id, limit, since }) => threads.watch(task_id, { limit, since }).pipe(Stream.mapError(taskNotFound)),
      "threads.page": ({ task_id, before, limit }) => threads.page(task_id, before, limit).pipe(Effect.mapError(taskNotFound)),
      "threads.answerQuestion": ({ task_id, request_id, choices, text }) =>
        questions.answer(task_id, request_id, { choices, text }).pipe(
          Effect.catchTags({
            TaskNotFound: (e) => Effect.fail(taskNotFound(e)),
            QuestionNotFound: (e) => Effect.fail(new NotFound({ what: "question", id: e.request_id })),
            QuestionClosed: (e) => Effect.fail(new Conflict({ reason: e.reason === "answered" ? "not_pending" : "moved_on", detail: e.detail })),
            AnswerInvalid: (e) => Effect.fail(new Invalid({ field: "answer", reason: e.reason })),
            ApprovalRefused: (e) => Effect.fail(new Conflict({ reason: e.reason, detail: e.detail })),
            SendRefused: sendRefused,
          }),
        ),
    })
  }),
)
