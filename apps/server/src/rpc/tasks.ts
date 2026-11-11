import { Effect } from "effect"
import { Conflict, Invalid, NotFound, Session, TaskRpcs, Unavailable } from "@huntaway/contracts"
import type { ConflictReason, Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { AgentTools } from "../agents/AgentTools.ts"
import { ContextMeter } from "../agents/ContextMeter.ts"
import { StackTitles } from "../agents/StackTitles.ts"
import { PullRequests } from "../github/PullRequests.ts"
import { MergeTargets } from "../merge/MergeTargets.ts"
import { InReview } from "../review/InReview.ts"
import type { FixChecksRefused } from "../review/InReview.ts"
import { DevServers } from "../runs/DevServers.ts"
import { Questions } from "../permissions/Questions.ts"
import { Reviews } from "../review/Reviews.ts"
import { Summaries } from "../review/Summaries.ts"
import type { ReviewRefused } from "../review/model.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
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
/** Why a message wasn't sent, as the contract has it. */
export const sendRefused = (e: SendRefused) => {
  const conflict = conflicts[e.reason]
  if (conflict !== null) return Effect.fail(new Conflict({ reason: conflict, detail: e.detail }))
  if (e.reason === "no_agents") return Effect.fail(new Unavailable({ what: "agents", reason: e.detail }))
  return Effect.fail(new Invalid({ field: "text", reason: e.detail }))
}

/** A review or summary refused, as the contract has it: the old 409s ("Can't review: …") and 400s. */
const reviewRefused = (e: ReviewRefused) =>
  Effect.fail(e.invalid ? new Invalid({ field: "id", reason: e.reason }) : new Conflict({ reason: "changed_meanwhile", detail: e.reason }))
/** Fix broken checks refused, as the contract's errors (the old 400 and 409s). */
const fixRefused = (e: FixChecksRefused) =>
  Effect.fail(
    e.reason === "not_open"
      ? new Conflict({ reason: "pr_not_open", detail: e.detail })
      : e.reason === "nothing_failed"
        ? new Conflict({ reason: "nothing_failed", detail: e.detail })
        : new Invalid({ field: "pr_url", reason: e.detail }),
  )

export const TaskHandlers = TaskRpcs.toLayer(
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const refs = yield* TaskRefs
    const runs = yield* Runs
    const deletion = yield* TaskDeletion
    const questions = yield* Questions
    const devServers = yield* DevServers
    const meter = yield* ContextMeter
    const stackTitles = yield* StackTitles
    const targets = yield* MergeTargets
    const reviews = yield* Reviews
    const summaries = yield* Summaries
    /** The task after a review or summary started, or as it is when there was nothing to start. */
    const orTask = (id: TaskId) => (t: Task | null) => (t !== null ? Effect.succeed(t) : tasks.get(id))
    const reviewErrors = { TaskNotFound: notFound.TaskNotFound, SendRefused: sendRefused, ReviewRefused: reviewRefused }
    const inReview = yield* InReview
    const pullRequests = yield* PullRequests
    const agentTools = yield* AgentTools
    return TaskRpcs.of({
      "tasks.list": ({ filter }) => tasks.list(filter).pipe(Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound })),
      "tasks.get": ({ id }) => refs.resolve(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, TaskRefAmbiguous: notFound.TaskRefAmbiguous })),
      // A task to start (`start`) starts; one with only a description gets its title written first (`Runs.created`).
      "tasks.create": ({ task }) =>
        Effect.flatMap(actor, (by) => tasks.create(task, by)).pipe(
          Effect.flatMap((created) => runs.created(created, task)),
          Effect.catchTags({ ProjectNotFound: notFound.ProjectNotFound, ProfileNotFound: notFound.ProfileNotFound }),
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, SendRefused: sendRefused }),
        ),
      "tasks.update": ({ id, patch }) =>
        Effect.flatMap(actor, (by) => tasks.update(id, patch, by)).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      // Its run is stopped at once and its queue dropped first, then its worktree goes (`TaskDeletion`).
      "tasks.delete": ({ id, delete_branch }) =>
        Effect.flatMap(actor, (by) => deletion.delete(id, { deleteBranch: delete_branch ?? false }, by)).pipe(
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound }),
        ),
      "tasks.send": ({ id, text }) =>
        runs.send(id, { text, source: "user" }).pipe(
          // The user's reply answers the questions the agent asked (`Questions`).
          Effect.tap(() => (text.trim() === "" ? Effect.void : questions.settle(id, "replied"))),
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, SendRefused: sendRefused }),
        ),
      // Its agent, and its review and summaries (4.6).
      "tasks.stop": ({ id }) =>
        Effect.gen(function* () {
          yield* tasks.get(id)
          return yield* reviews.stopTask(id)
        }).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.review": ({ id }) => reviews.start(id, true).pipe(Effect.flatMap(orTask(id)), Effect.catchTags(reviewErrors)),
      "tasks.extendReview": ({ id }) => reviews.extend(id).pipe(Effect.catchTags(reviewErrors)),
      "tasks.summarize": ({ id }) => summaries.start(id, true).pipe(Effect.flatMap(orTask(id)), Effect.catchTags(reviewErrors)),
      "tasks.dropQueued": ({ id }) => runs.dropQueued(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.stopServer": ({ id, port }) => devServers.stop(id, port).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.stopBackground": ({ id, background_id }) =>
        Effect.gen(function* () {
          yield* tasks.get(id)
          return { stopping: yield* runs.stopBackground(id, background_id ?? null) }
        }).pipe(
          Effect.catchTags({
            TaskNotFound: notFound.TaskNotFound,
            BackgroundRefused: (e) => Effect.fail(new Conflict({ reason: "changed_meanwhile", detail: e.reason })),
          }),
        ),
      "tasks.waitForLimit": ({ id }) =>
        runs.waitForReset(id).pipe(
          Effect.catchTags({
            TaskNotFound: notFound.TaskNotFound,
            WaitRefused: (e) =>
              Effect.fail(e.invalid ? new Invalid({ field: "id", reason: e.reason }) : new Conflict({ reason: "changed_meanwhile", detail: e.reason })),
          }),
        ),
      "tasks.context": ({ id }) => meter.get(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      // 4.8: a stack's title and description, by hand or written again.
      "tasks.updateStack": ({ id, title, description, regenerate }) =>
        stackTitles
          .update(id, { title, description, regenerate })
          .pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, StackInvalid: (e) => Effect.fail(new Invalid({ field: e.field, reason: e.reason })) })),
      // 4.8: where the tasks held by a closed or deleted task go now, and a whole stack's merge.
      "tasks.mergeTarget": ({ id, to }) => targets.setTarget(id, to).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      "tasks.mergeStack": ({ id }) => targets.mergeStack(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
      // 4.5: Fix broken checks, and whether Done would leave work unmerged.
      "tasks.fixChecks": ({ id }) =>
        inReview.fixChecks(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound, SendRefused: sendRefused, FixChecksRefused: fixRefused })),
      "tasks.unmerged": ({ id }) =>
        tasks.get(id).pipe(
          Effect.flatMap((t) => pullRequests.unmerged(t)),
          Effect.map((unmerged) => ({ unmerged })),
          Effect.catchTags({ TaskNotFound: notFound.TaskNotFound }),
        ),
      // 6.4: the skills for the composer's `/` menu.
      "tasks.skills": ({ id }) => agentTools.taskSkills(id).pipe(Effect.catchTags({ TaskNotFound: notFound.TaskNotFound })),
    })
  }),
)
