import { Context, Effect, Layer, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Conflict, PenId, TaskId } from "@huntaway/contracts"
import type { AgentConfigId, Invalid, NewPen, Pen, PenPatch, ProfileId, Task } from "@huntaway/contracts"
import { Changes } from "../platform/Changes.ts"
import type { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { checkPenName, nextPenColor, reordered } from "./penChecks.ts"
import { PenRepo } from "./PenRepo.ts"
import type { PenColumns } from "./PenRepo.ts"
import { TaskRepo } from "./TaskRepo.ts"
import { Tasks } from "./Tasks.ts"

export class PenNotFound extends Schema.TaggedError<PenNotFound, { readonly brand: unique symbol }>()("PenNotFound", { id: Schema.String }) {}

const taken = (name: string) => new Conflict({ reason: "duplicate_name", detail: `there's a pen named ${name} already` })

/** A pen's own thread's title. */
export const penThreadTitle = (name: string): string => `Pen: ${name}`

export interface PensShape {
  /** A profile's pens, in their tabs' order, each with how many tasks it has. */
  readonly list: (profile: ProfileId) => Effect.Effect<ReadonlyArray<Pen>, ProfileNotFound>
  /** A new pen at the end of the profile's tabs, with a colour its other pens don't have unless one is given. Emits `pens`. */
  readonly create: (input: NewPen) => Effect.Effect<Pen, ProfileNotFound | Invalid | Conflict>
  /** Renames, recolours, marks active or inactive, or moves its tab (`index`, from 0). Its thread is renamed with it. Emits `pens`. */
  readonly update: (id: PenId, patch: PenPatch) => Effect.Effect<Pen, PenNotFound | Invalid | Conflict>
  /**
   * Deletes a pen: its tasks are in no pen after (a `task` event each), then `pens`, then its own thread is deleted. A
   * pen's thread can't delete its own pen (it would delete the thread that asks). The tasks it left.
   */
  readonly delete: (id: PenId, by: Actor) => Effect.Effect<ReadonlyArray<TaskId>, PenNotFound | Conflict>
  /**
   * The profile's pens thread (HA-285, the old `GET /profiles/{id}/pens-thread`): the one lasting thread in no project
   * that arranges its pens, keyed among its scratch tasks (`S-<n>`), made the first time it's asked for. Emits `task`
   * when it's made.
   */
  readonly thread: (profile: ProfileId) => Effect.Effect<Task, ProfileNotFound>
  /**
   * A pen's own thread (HA-293, the old `GET /pens/{id}/thread`), which works on its tasks: titled after it, keyed among
   * the profile's scratch tasks, made the first time it's asked for (or again once it was deleted). Emits `task` and
   * `pens` when it's made.
   */
  readonly penThread: (id: PenId) => Effect.Effect<Task, PenNotFound>
}

/**
 * Pens (docs/plan/inventory/02-agent-support.md 2.9): a profile's named sets of tasks, from any of its projects and
 * none, which its board shows as tabs. A task is in one pen at most (`tasks.pen_id`, set by `Tasks.update`).
 */
export class Pens extends Context.Service<Pens, PensShape>()("huntaway-server/tasks/Pens") {
  static readonly layer = Layer.effect(
    Pens,
    Effect.gen(function* () {
      const repo = yield* PenRepo
      const taskRepo = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const tasks = yield* Tasks
      const db = yield* Db
      const events = yield* Events
      const changes = yield* Changes
      const random = yield* SecureRandom.SecureRandom

      const load = Effect.fnUntraced(function* (id: string) {
        const pen = yield* repo.get(id)
        if (pen === null) return yield* new PenNotFound({ id })
        return pen
      })
      /** Tells the boards the profile's pens changed (after the commit, inside a transaction). */
      const changed = (profile: ProfileId) => Effect.flatMap(repo.list(profile), (pens) => events.emit({ type: "pens", profile_id: profile, pens }))

      const list = Effect.fn("Pens.list")(function* (profile: ProfileId) {
        if ((yield* profiles.get(profile))._tag === "None") return yield* new ProfileNotFound({ id: profile })
        return yield* repo.list(profile)
      })

      const create = Effect.fn("Pens.create")(function* (input: NewPen) {
        const name = yield* Effect.fromResult(checkPenName(input.name))
        const id = PenId.make(yield* random.uuidV4())
        const now = yield* nowTimestamp
        return yield* db.tx(
          Effect.gen(function* () {
            if ((yield* profiles.get(input.profile_id))._tag === "None") return yield* new ProfileNotFound({ id: input.profile_id })
            if ((yield* repo.byName(input.profile_id, name)) !== null) return yield* taken(name)
            const color = input.color ?? nextPenColor((yield* repo.list(input.profile_id)).map((p) => p.color))
            yield* repo.insert({ id, profile_id: input.profile_id, name, active: input.active ?? true, color, now })
            yield* changed(input.profile_id)
            // Just inserted, in this transaction.
            return yield* load(id).pipe(Effect.orDie)
          }),
        )
      })

      const update = Effect.fn("Pens.update")(function* (id: PenId, patch: PenPatch) {
        const name = patch.name === undefined ? undefined : yield* Effect.fromResult(checkPenName(patch.name))
        const now = yield* nowTimestamp
        const { before, after } = yield* db.tx(
          Effect.gen(function* () {
            const was = yield* load(id)
            if (name !== undefined) {
              const other = yield* repo.byName(was.profile_id, name)
              if (other !== null && other.id !== id) return yield* taken(name)
            }
            const columns: PenColumns = { name, active: patch.active, color: patch.color }
            yield* repo.update(id, columns, now)
            if (patch.index !== undefined) yield* repo.order(reordered(yield* repo.list(was.profile_id), id, patch.index).map((p) => p.id))
            yield* changed(was.profile_id)
            return { before: was, after: yield* load(id) }
          }),
        )
        // Its thread is named after it (huntaway's agent/pens.ts `pen_changed`).
        if (after.thread_id !== null && after.name !== before.name) {
          const title = penThreadTitle(after.name)
          yield* tasks
            .change(after.thread_id, (t) => (t.title === title ? null : { title }), { _tag: "Board" })
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
        }
        return after
      })

      const remove = Effect.fn("Pens.delete")(function* (id: PenId, by: Actor) {
        const { pen, left } = yield* db.tx(
          Effect.gen(function* () {
            const gone = yield* load(id)
            if (by._tag === "Agent" && gone.thread_id !== null && by.task_id === gone.thread_id) {
              return yield* new Conflict({ reason: "in_use", detail: "a pen's thread can't delete its pen: the user does that from the board" })
            }
            const ids = yield* repo.delete(id)
            const out = yield* taskRepo.getMany(ids)
            for (const task of out) yield* events.emit({ type: "task", task })
            yield* changed(gone.profile_id)
            return { pen: gone, left: out }
          }),
        )
        yield* Effect.forEach(left, (after) => changes.offer({ _tag: "TaskChanged", before: Object.assign({}, after, { pen_id: id }), after, cause: by }), {
          concurrency: 1,
          discard: true,
        })
        // Its own thread has no pen to work on.
        if (pen.thread_id !== null) {
          const thread = yield* taskRepo.get(pen.thread_id)
          if (thread !== null && thread.kind === "task" && thread.task_type === "pen") {
            yield* tasks.delete(thread.id, { deleteBranch: false }, by).pipe(Effect.catchTags({ TaskNotFound: () => Effect.void, Conflict: () => Effect.void }))
          }
        }
        return left.map((t) => t.id)
      })

      /**
       * The config a new pens thread starts with (the old `thread_config`): the one its profile picks for its pens'
       * threads, if still one of its configs, else its first.
       */
      const threadConfig = Effect.fnUntraced(function* (profile: ProfileId, picked: AgentConfigId | null) {
        const configs = yield* taskRepo.configs(profile, null)
        return configs.find((c) => c === picked) ?? configs[0] ?? null
      })

      /** Adds a lasting thread of the profile's in no project, numbered among its scratch tasks; in the caller's transaction. */
      const insertThread = Effect.fnUntraced(function* (id: TaskId, profile: ProfileId, type: "pens" | "pen", title: string, config: AgentConfigId | null) {
        const at = yield* nowTimestamp
        yield* taskRepo.insert(
          id,
          {
            family: "scratch",
            profile_id: profile,
            project_id: null,
            generateTitle: false,
            // Its title stays: it isn't renamed after the user's prompts (a pen's is renamed with its pen).
            columns: { title, description: "", status: "todo", use_worktree: false, task_type: type, title_pinned: true, claude_config_id: config },
          },
          at,
        )
        const task = yield* taskRepo.get(id)
        if (task === null) return yield* Effect.die(new Error("the thread's row is gone"))
        return task
      })

      const findPensThread = (profile: ProfileId) =>
        Effect.map(taskRepo.list({ _tag: "Projectless", profile_id: profile, include_pens: true }), (all) => all.find((t) => t.task_type === "pens") ?? null)

      const thread = Effect.fn("Pens.thread")(function* (profile: ProfileId) {
        const had = yield* findPensThread(profile)
        if (had !== null) return had
        const p = yield* profiles.get(profile)
        if (p._tag === "None") return yield* new ProfileNotFound({ id: profile })
        const id = TaskId.make(yield* random.uuidV4())
        const config = yield* threadConfig(profile, p.value.threads_config_id)
        // Looked for again in the transaction that makes it, so two first opens make one.
        const made = yield* db.tx(
          Effect.gen(function* () {
            const there = yield* findPensThread(profile)
            if (there !== null) return { task: there, made: false }
            return { task: yield* insertThread(id, profile, "pens", "Pens", config), made: true }
          }),
        )
        if (made.made) yield* events.emit({ type: "task", task: made.task })
        return made.task
      })

      const penThread = Effect.fn("Pens.penThread")(function* (penId: PenId) {
        const pen = yield* load(penId)
        if (pen.thread_id !== null) {
          const had = yield* taskRepo.get(pen.thread_id)
          if (had !== null) return had
        }
        const p = yield* profiles.get(pen.profile_id)
        const config = yield* threadConfig(pen.profile_id, p._tag === "Some" ? p.value.threads_config_id : null)
        const id = TaskId.make(yield* random.uuidV4())
        const now = yield* nowTimestamp
        // Its pen read again in the transaction that makes it, so two first opens make one.
        return yield* db.tx(
          Effect.gen(function* () {
            const was = yield* load(penId)
            const there = was.thread_id === null ? null : yield* taskRepo.get(was.thread_id)
            if (there !== null) return there
            const task = yield* insertThread(id, was.profile_id, "pen", penThreadTitle(was.name), config)
            yield* repo.update(penId, { thread_id: id }, now)
            yield* events.emit({ type: "task", task })
            yield* changed(was.profile_id)
            return task
          }),
        )
      })

      return Pens.of({ list, create, update, delete: remove, thread, penThread })
    }),
  )
}
