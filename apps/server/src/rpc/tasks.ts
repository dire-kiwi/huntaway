import { Effect } from "effect"
import { Conflict, Invalid, NotFound, Session, TaskRpcs, Unavailable } from "@huntaway/contracts"
import type { ConflictReason } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
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

/** A message `Runs` refused, as the contract's errors (the old 409s, 400s and 503). */
const conflicts: { readonly [R in SendRefused["reason"]]: ConflictReason | null } = {
  archived: "archived",
  merge_queued: "merging",
  already_running: "already_running",
  agent_running: "agent_running",
  nothing_queued: "changed_meanwhile",
  no_conversation: null,
  no_agents: null,
}
const sendRefused = (e: SendRefused) => {
  const conflict = conflicts[e.reason]
  if (conflict !== null) return Effect.fail(new Conflict({ reason: conflict, detail: e.detail }))
  if (e.reason === "no_agents") return Effect.fail(new Unavailable({ what: "agents", reason: e.detail }))
  return Effect.fail(new Invalid({ field: "text", reason: e.detail }))
}

export const TaskHandlers = TaskRpcs.toLayer(
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const refs = yield* TaskRefs
    const runs = yield* Runs
    return TaskRpcs.of({
      "tasks.list": ({ filter }) => tasks.list(filter).pipe(Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound })),
      "tasks.get": ({ id }) => refs.resolve(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, TaskRefAmbiguous: notFound.TaskRefAmbiguous })),
      "tasks.create": ({ task }) =>
        Effect.flatMap(actor, (by) => tasks.create(task, by)).pipe(
          Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound, ProfileNotFound: notFound.ProfileNotFound }),
        ),
      "tasks.update": ({ id, patch }) =>
        Effect.flatMap(actor, (by) => tasks.update(id, patch, by)).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      // Its run is stopped at once and its queue dropped first (`Runs.abort`).
      "tasks.delete": ({ id, delete_branch }) =>
        Effect.flatMap(actor, (by) => runs.abort(id).pipe(Effect.andThen(tasks.delete(id, { deleteBranch: delete_branch ?? false }, by)))).pipe(
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound }),
        ),
      "tasks.send": ({ id, text }) =>
        runs.send(id, { text, source: "user" }).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, SendRefused: sendRefused })),
      "tasks.stop": ({ id }) =>
        Effect.gen(function* () {
          yield* tasks.get(id)
          return yield* runs.stop(id)
        }).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.dropQueued": ({ id }) => runs.dropQueued(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
    })
  }),
)
