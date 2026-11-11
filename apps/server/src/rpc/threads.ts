import { Effect, Stream } from "effect"
import { NotFound, ThreadRpcs } from "@huntaway/contracts"
import { Threads } from "../threads/Threads.ts"

const taskNotFound = (e: { readonly id: string }) => new NotFound({ what: "task", id: e.id })

export const ThreadHandlers = ThreadRpcs.toLayer(
  Effect.gen(function* () {
    const threads = yield* Threads
    return ThreadRpcs.of({
      "threads.watch": ({ task_id, limit, since }) => threads.watch(task_id, { limit, since }).pipe(Stream.mapError(taskNotFound)),
      "threads.page": ({ task_id, before, limit }) => threads.page(task_id, before, limit).pipe(Effect.mapError(taskNotFound)),
    })
  }),
)
