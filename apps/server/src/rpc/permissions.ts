import { Effect } from "effect"
import { Conflict, NotFound, PermissionRpcs, Session } from "@huntaway/contracts"
import type { AnsweredBy } from "@huntaway/contracts"
import { Permissions } from "../permissions/Permissions.ts"
import { sendRefused } from "./tasks.ts"

/** Who answered: a paired device's answer is a push's, as the old `via: "push"` said. */
const answeredBy: Effect.Effect<AnsweredBy, never, Session> = Effect.map(Session, (s) => (s.kind === "device" ? "push" : "user"))

export const PermissionHandlers = PermissionRpcs.toLayer(
  Effect.gen(function* () {
    const permissions = yield* Permissions
    return PermissionRpcs.of({
      "permissions.pending": ({ task_id, profile_id }) => permissions.pending({ task: task_id, profile: profile_id }),
      "permissions.answer": ({ id, answer }) =>
        Effect.flatMap(answeredBy, (by) => permissions.answer(id, answer, by)).pipe(
          Effect.map((status) => ({ status })),
          Effect.catchTags({
            PromptNotFound: (e) => Effect.fail(new NotFound({ what: "permission request", id: e.id })),
            PromptNotPending: () => Effect.fail(new Conflict({ reason: "not_pending", detail: "this request is no longer pending" })),
            PromptMovedOn: () =>
              Effect.fail(new Conflict({ reason: "moved_on", detail: "the conversation has moved on since this was asked: reply in the thread instead" })),
            TaskNotFound: (e) => Effect.fail(new NotFound({ what: "task", id: e.id })),
            SendRefused: sendRefused,
          }),
        ),
      "permissions.approvals": () => permissions.approvals,
    })
  }),
)
