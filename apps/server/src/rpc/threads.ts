import { Effect, Stream } from "effect"
import { Conflict, Invalid, NotFound, ThreadRpcs } from "@huntaway/contracts"
import { Connections } from "../assistant/Connections.ts"
import { Suggestions } from "../assistant/Suggestions.ts"
import { Push } from "../push/Push.ts"
import { Questions } from "../permissions/Questions.ts"
import { Threads } from "../threads/Threads.ts"
import { actor, sendRefused } from "./tasks.ts"

const taskNotFound = (e: { readonly id: string }) => new NotFound({ what: "task", id: e.id })

export const ThreadHandlers = ThreadRpcs.toLayer(
  Effect.gen(function* () {
    const threads = yield* Threads
    const questions = yield* Questions
    const connections = yield* Connections
    const suggestions = yield* Suggestions
    const push = yield* Push
    const cardErrors = {
      TaskNotFound: (e: { readonly id: string }) => Effect.fail(taskNotFound(e)),
      QuestionNotFound: (e: { readonly request_id: string }) => Effect.fail(new NotFound({ what: "connection card", id: e.request_id })),
      QuestionClosed: (e: { readonly reason: "answered" | "moved_on"; readonly detail: string }) =>
        Effect.fail(new Conflict({ reason: e.reason === "answered" ? "not_pending" : "moved_on", detail: e.detail })),
      SendRefused: sendRefused,
    }
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
      "threads.checkConnection": ({ task_id, request_id }) => connections.check(task_id, request_id).pipe(Effect.catchTags(cardErrors)),
      "threads.skipConnection": ({ task_id, request_id }) => connections.skip(task_id, request_id).pipe(Effect.catchTags(cardErrors)),
      // HE-61: as the user (or the device), whose move of the task doesn't notify them, as the board's own buttons.
      "threads.actOnSuggestion": ({ task_id, item_id, index, choice, todos_override }) =>
        Effect.flatMap(actor, (by) => suggestions.act(task_id, item_id, index, choice, { by, beforeMove: push.noteMove, todosOverride: todos_override })).pipe(
          Effect.catchTags({
            TaskNotFound: (e) => Effect.fail(taskNotFound(e)),
            SuggestionNotFound: (e) => Effect.fail(new NotFound({ what: "suggestion", id: `${e.item_id}#${e.index}` })),
            SuggestionClosed: (e) => Effect.fail(new Conflict({ reason: "not_pending", detail: e.detail })),
            SendRefused: sendRefused,
          }),
        ),
    })
  }),
)
