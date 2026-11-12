import { Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { TaskId } from "@huntaway/contracts"
import type { ProfileId, Task } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Identity } from "../platform/Identity.ts"
import { rowsOf } from "../platform/columns.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"

// What routines need of the profile's assistant (docs/plan/06-server.md, Automations and Assistant): the assistant area
// (6.7) sits below automations in the dependency order, so `Routines` can't call it. The assistant registers what it
// offers here when its layer is built (`register`), as the merge area does with `MergeFacts`. Until it does (and in
// tests that build no assistant) routines use what the rows say: the profile's existing assistant thread (none is made:
// a routine fails "has no assistant yet"), its folder as its workspace, no Google, and its `assistant_host`.

/** The assistant can't be reached or used for a routine (why, as a run's detail says it). */
export class RoutineHostError extends Schema.TaggedError<RoutineHostError, { readonly brand: unique symbol }>()("RoutineHostError", {
  reason: Schema.String,
}) {}

/** What the assistant area offers routines. */
export interface AssistantAccess {
  /** The profile's assistant, made if it has none (the old `assistant.get_or_create`). */
  readonly assistant: (profile: ProfileId) => Effect.Effect<Task, RoutineHostError>
  /** The assistant's workspace, checked (not one that's become a symlink): where a routine's precheck runs. */
  readonly workspace: (assistant: Task) => Effect.Effect<string, RoutineHostError>
  /** Where the assistant's Google server stands, for a routine's `{{google}}` (the old `google.status_line`); null for nothing to say. */
  readonly google: (profile: ProfileId) => Effect.Effect<string | null>
}

export interface RoutineHostShape extends AssistantAccess {
  /** The assistant area's, from now on. */
  readonly register: (access: AssistantAccess) => Effect.Effect<void>
  /**
   * Why routines on this host don't wake the profile's assistant (it runs on another host: HA-241), as the user is told;
   * null when they do.
   */
  readonly elsewhere: (profile: ProfileId) => Effect.Effect<string | null>
}

const IdRow = Schema.Struct({ id: TaskId })
const idRows = rowsOf(IdRow)

export class RoutineHost extends Context.Service<RoutineHost, RoutineHostShape>()("huntaway-server/automations/RoutineHost") {
  static readonly layer = Layer.effect(
    RoutineHost,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const tasks = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const identity = yield* Identity
      const fs = yield* FileSystem.FileSystem

      /** Until the assistant area registers: the profile's assistant thread as it is. */
      const rows: AssistantAccess = {
        assistant: Effect.fnUntraced(function* (profile: ProfileId) {
          const found = yield* idRows(sql`SELECT id FROM tasks WHERE profile_id = ${profile} AND task_type = 'assistant' LIMIT 1`)
          const t = found[0] === undefined ? null : yield* tasks.get(found[0].id)
          if (t === null) return yield* new RoutineHostError({ reason: "the profile has no assistant on this host yet" })
          return t
        }),
        workspace: Effect.fnUntraced(function* (assistant: Task) {
          const dir = assistant.work_dir
          if (dir === null) return yield* new RoutineHostError({ reason: "the assistant's workspace: it has none" })
          const link = yield* fs.readLink(dir).pipe(Effect.option)
          if (Option.isSome(link)) return yield* new RoutineHostError({ reason: `the assistant's workspace: ${dir} is a symlink` })
          const isDir = yield* fs.stat(dir).pipe(
            Effect.map((s) => s.type === "Directory"),
            Effect.orElseSucceed(() => false),
          )
          if (!isDir) return yield* new RoutineHostError({ reason: `the assistant's workspace: ${dir} isn't a folder` })
          return dir
        }),
        google: () => Effect.succeed(null),
      }
      const access = yield* Ref.make<AssistantAccess>(rows)

      const elsewhere = Effect.fnUntraced(function* (profile: ProfileId) {
        const p = yield* profiles.get(profile)
        if (Option.isNone(p)) return null
        const host = p.value.assistant_host
        if (host === null || String(host) === String(identity.hostId)) return null
        // The link's name is M7's: its id until then.
        return `${p.value.name}'s assistant runs on ${host}, so routines on ${identity.hostName} don't wake it: make this one on ${host}, in its assistant's Routines tab there`
      })

      return RoutineHost.of({
        register: (a) => Ref.set(access, a),
        assistant: (profile) => Effect.flatMap(Ref.get(access), (a) => a.assistant(profile)),
        workspace: (t) => Effect.flatMap(Ref.get(access), (a) => a.workspace(t)),
        google: (profile) => Effect.flatMap(Ref.get(access), (a) => a.google(profile)),
        elsewhere,
      })
    }),
  )
}
