import { Context, Effect, Layer } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { reachesAgent } from "../runs/queue.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { Permissions } from "./Permissions.ts"
import { Questions } from "./Questions.ts"

// A message the user sends a task's agent (the board's `tasks.send`, and a suggestions card's Send the message, HE-61):
// sent with `Runs.send`, and then, for one that says something, it answers the questions the agent asked (`Questions`)
// and skips its permission prompts (`Permissions.skipFor`), so that it reads the message now. One queued for after the
// agent's turn (HE-113) leaves its prompts be: the turn goes on as it was, and the message waits for its end.

export interface UserMessagesShape {
  /** Sends `text` to `task`'s agent as the user's message (with `queue`, once its turn is over); the task as it is after. */
  readonly send: (task: TaskId, text: string, queue?: boolean) => Effect.Effect<Task, TaskNotFound | SendRefused>
}

export class UserMessages extends Context.Service<UserMessages, UserMessagesShape>()("huntaway-server/permissions/UserMessages") {
  static readonly layer = Layer.effect(
    UserMessages,
    Effect.gen(function* () {
      const runs = yield* Runs
      const questions = yield* Questions
      const permissions = yield* Permissions

      const send = Effect.fn("UserMessages.send")(function* (task: TaskId, text: string, queue?: boolean) {
        const sent = yield* runs.send(task, { text, source: "user", ...(queue === true ? { queue } : {}) })
        // A board command the agent never sees (HE-102: `/output-style`) answers nothing.
        if (reachesAgent(text)) {
          yield* questions.settle(task, "replied")
          if (queue !== true) yield* permissions.skipFor(task)
        }
        return sent
      })

      return UserMessages.of({ send })
    }),
  )
}
