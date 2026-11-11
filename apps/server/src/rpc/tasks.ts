import { Effect } from "effect"
import { NotFound, Session, TaskRpcs } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { TaskRefs } from "../tasks/TaskRefs.ts"
import { Tasks } from "../tasks/Tasks.ts"

/** Who a session acts as: a paired device, or the board's user. */
const actor: Effect.Effect<Actor, never, Session> = Effect.gen(function* () {
  const s = yield* Session
  return s.kind === "device" && s.device_id !== null ? { _tag: "Device", device_id: s.device_id } : Actor.user
})

/** The service's not-founds as the contract's. An ambiguous key is not found as given (name it by `<profile>:<key>` or id). */
const notFound = {
  TaskNotFound: (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id })),
  TaskRefAmbiguous: (e: { readonly ref: string }) => Effect.fail(new NotFound({ what: "task", id: e.ref })),
  ProjectNotFound: (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "project", id: e.id })),
  ProfileNotFound: (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "profile", id: e.id })),
}

export const TaskHandlers = TaskRpcs.toLayer(
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const refs = yield* TaskRefs
    return TaskRpcs.of({
      "tasks.list": ({ filter }) => tasks.list(filter).pipe(Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound })),
      "tasks.get": ({ id }) => refs.resolve(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, TaskRefAmbiguous: notFound.TaskRefAmbiguous })),
      "tasks.create": ({ task }) =>
        Effect.flatMap(actor, (by) => tasks.create(task, by)).pipe(
          Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound, ProfileNotFound: notFound.ProfileNotFound }),
        ),
      "tasks.update": ({ id, patch }) =>
        Effect.flatMap(actor, (by) => tasks.update(id, patch, by)).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.delete": ({ id, delete_branch }) =>
        Effect.flatMap(actor, (by) => tasks.delete(id, { deleteBranch: delete_branch ?? false }, by)).pipe(
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound }),
        ),
    })
  }),
)
