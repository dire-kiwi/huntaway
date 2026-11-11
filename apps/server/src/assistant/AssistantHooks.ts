import { Effect, Layer, Result } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { RoutineHost, RoutineHostError } from "../automations/RoutineHost.ts"
import { Routines } from "../automations/Routines.ts"
import { Events } from "../platform/Events.ts"
import { AssistantLaunch, WorkspaceRefused } from "../runs/AssistantLaunch.ts"
import { TurnHooks } from "../runs/TurnHooks.ts"
import type { TurnEnd } from "../runs/TurnHooks.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Assistant } from "./Assistant.ts"
import { Brief } from "./Brief.ts"
import { Google } from "./Google.ts"
import { Memory } from "./Memory.ts"

// What the assistant area registers with the areas above it, which can't call it (docs/plan/06-server.md, Assistant):
//
// - `RoutineHost` (automations): a routine's assistant (made if need be), its checked workspace, and `{{google}}`.
// - `AssistantLaunch` (runs): the assistant and its routine threads work in its workspace and are told its memory; the
//   assistant's prompt run starts with its routines' unread reports, read once its agent has started.
// - `TurnHooks` (runs): after a tool call or a turn of the assistant or a routine thread, the brief follows its files; a
//   turn's end commits what changed in the workspace and, for the assistant's own turn (not a compaction's), tells push
//   it replied (`assistant_reply`).

export const AssistantHooks = Layer.effectDiscard(
  Effect.gen(function* () {
    const assistant = yield* Assistant
    const memory = yield* Memory
    const brief = yield* Brief
    const google = yield* Google
    const routines = yield* Routines
    const tasks = yield* TaskRepo
    const events = yield* Events

    yield* (yield* RoutineHost).register({
      assistant: (profile) =>
        assistant.get(profile).pipe(Effect.mapError((e) => new RoutineHostError({ reason: e._tag === "Unavailable" ? e.reason : `no ${e.what} ${e.id}` }))),
      workspace: (t) => memory.checked(t).pipe(Effect.mapError((e) => new RoutineHostError({ reason: `the assistant's workspace: ${e.reason}` }))),
      google: (profile) => google.line(profile),
    })

    /** The assistant whose workspace a run of `t` works in, if any (none for a routine whose assistant is gone). */
    const whose = (t: Task) => Effect.map(Effect.result(assistant.whoseWorkspace(t)), (r) => (Result.isSuccess(r) ? r.success : null))

    yield* (yield* AssistantLaunch).register({
      workspace: Effect.fnUntraced(function* (t: Task) {
        const owner = yield* assistant
          .whoseWorkspace(t)
          .pipe(Effect.mapError((e) => new WorkspaceRefused({ reason: `the assistant's workspace: ${e.reason}` })))
        if (owner === null) return null
        // Only in a workspace of its own: not one that's become a symlink, which could be another's.
        const dir = yield* memory.checked(owner).pipe(Effect.mapError((e) => new WorkspaceRefused({ reason: `the assistant's workspace: ${e.reason}` })))
        return { cwd: dir, memory: yield* memory.forRun(owner) }
      }),
      reports: Effect.fnUntraced(function* (t: Task) {
        if (t.kind !== "task" || t.task_type !== "assistant") return null
        const unread = yield* routines.unreadReports(t.id)
        if (unread === null) return null
        return { preface: unread.text, started: routines.markRead(t.id, unread.reports) }
      }),
    })

    const turnEnded = Effect.fnUntraced(function* (id: TaskId, end?: TurnEnd) {
      const t = yield* tasks.get(id)
      if (t === null) return
      const owner = yield* whose(t)
      if (owner === null) return
      yield* brief.keep(id, true)
      yield* memory.turnEnded(owner)
      if (end !== undefined && !end.compact && t.task_type === "assistant")
        yield* events.emit({ type: "assistant_reply", task_id: t.id, profile_id: t.profile_id })
    })

    yield* (yield* TurnHooks).register({
      toolDone: (id) => brief.keep(id, false),
      turnEnded,
    })
  }),
)
