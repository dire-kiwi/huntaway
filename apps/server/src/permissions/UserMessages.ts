import { Context, Effect, Layer } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { Permissions } from "./Permissions.ts"
import { Questions } from "./Questions.ts"

// A message the user sends a task's agent (the board's `tasks.send`, and a suggestions card's Send the message, HE-61):
// sent with `Runs.send`, and then, for one that says something, it answers the questions the agent asked (`Questions`)
// and skips its permission prompts (`Permissions.skipFor`), so that it reads the message now.

export interface UserMessagesShape {
  /** Sends `text` to `task`'s agent as the user's message; the task as it is after. */
  readonly send: (task: TaskId, text: string) => Effect.Effect<Task, TaskNotFound | SendRefused>
}

export class UserMessages extends Context.Service<UserMessages, UserMessagesShape>()("huntaway-server/permissions/UserMessages") {
  static readonly layer = Layer.effect(
    UserMessages,
    Effect.gen(function* () {
      const runs = yield* Runs
      const questions = yield* Questions
      const permissions = yield* Permissions

      const send = Effect.fn("UserMessages.send")(function* (task: TaskId, text: string) {
        const sent = yield* runs.send(task, { text, source: "user" })
        if (text.trim() !== "") yield* Effect.andThen(questions.settle(task, "replied"), permissions.skipFor(task))
        return sent
      })

      return UserMessages.of({ send })
    }),
  )
}
