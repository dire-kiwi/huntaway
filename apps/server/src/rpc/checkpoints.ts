import { Effect } from "effect"
import { CheckpointRpcs, Conflict, Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import { Checkpoints } from "../git/Checkpoints.ts"

const taskNotFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const gitFailed = (e: { readonly reason: string }) => Effect.fail(new Unavailable({ what: "git", reason: e.reason }))
const refused = (e: { readonly reason: Conflict["reason"]; readonly detail: string }) => Effect.fail(new Conflict({ reason: e.reason, detail: e.detail }))
const invalid = (e: { readonly field: string; readonly reason: string }) => Effect.fail(new Invalid({ field: e.field, reason: e.reason }))

export const CheckpointHandlers = CheckpointRpcs.toLayer(
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints
    return CheckpointRpcs.of({
      "checkpoints.turns": ({ task_id }) => checkpoints.turns(task_id).pipe(Effect.catchTags({ TaskNotFound: taskNotFound, CheckpointFailed: gitFailed })),
      "checkpoints.turnDiff": ({ task_id, from, to }) =>
        checkpoints.turnDiff(task_id, from, to).pipe(
          Effect.catchTags({
            TaskNotFound: taskNotFound,
            CheckpointNotFound: (e) => Effect.fail(new NotFound({ what: "checkpoint", id: String(e.n) })),
            CheckpointInvalid: invalid,
            RewindRefused: refused,
            CheckpointFailed: gitFailed,
          }),
        ),
      "checkpoints.rewind": ({ task_id, message_id, conversation, branch }) =>
        checkpoints
          .rewind(task_id, message_id, { conversation: conversation ?? false, branch: branch ?? false })
          .pipe(Effect.catchTags({ TaskNotFound: taskNotFound, CheckpointInvalid: invalid, RewindRefused: refused, CheckpointFailed: gitFailed })),
      "checkpoints.cancelRewind": ({ task_id }) => checkpoints.cancelRewind(task_id).pipe(Effect.catchTag("TaskNotFound", taskNotFound)),
    })
  }),
)
