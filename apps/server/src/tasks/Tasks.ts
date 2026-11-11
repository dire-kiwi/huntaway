import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Conflict, Invalid, NotFound, PenId, TaskId, Timestamp } from "@huntaway/contracts"
import type { NewTask, Task, TaskFilter, TaskPatch } from "@huntaway/contracts"
import { Changes } from "../platform/Changes.ts"
import type { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { decideCreate, decideDeleted, decideUpdate, deriveColumns } from "./decide.ts"
import { nextPenColor, penWanted } from "./penChecks.ts"
import { PenRepo } from "./PenRepo.ts"
import type { CreateFacts, TaskColumns, UpdateFacts } from "./decide.ts"
import { TaskRepo } from "./TaskRepo.ts"
import type { ProjectRef } from "./TaskRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { ProjectNotFound } from "../projects/Projects.ts"

export class TaskNotFound extends Schema.TaggedError<TaskNotFound, { readonly brand: unique symbol }>()("TaskNotFound", { id: Schema.String }) {}

export interface TasksShape {
  readonly get: (id: TaskId) => Effect.Effect<Task, TaskNotFound>
  /** A project's tasks (`ProjectNotFound` for a project that isn't there), a profile's, or its tasks in no project. */
  readonly list: (filter: TaskFilter) => Effect.Effect<ReadonlyArray<Task>, ProjectNotFound>
  /** A task in a project, a scratch task in none, or a group task (`NewTask` says which). */
  readonly create: (input: NewTask, by: Actor) => Effect.Effect<Task, ProjectNotFound | ProfileNotFound | Invalid | Conflict>
  /**
   * `pen` puts it in the profile's pen by that name (made, with a `pens` event, if there's none) and `pen_id` in a pen
   * by id (`NotFound` for one that isn't the profile's); null or blank takes it out.
   */
  readonly update: (id: TaskId, patch: TaskPatch, by: Actor) => Effect.Effect<Task, TaskNotFound | Invalid | Conflict | NotFound>
  /**
   * For other services: change columns the patch does not expose, with the same derived columns. `decide` sees the task
   * as it is under its lock and returns the columns to write, or null to leave it.
   */
  readonly change: (id: TaskId, decide: (task: Task) => TaskColumns | null, cause: Actor) => Effect.Effect<Task, TaskNotFound>
  /**
   * Deletes a task by hand, in order: what points at it is put right (dependants, tasks merging into it, stack levels on
   * it), its queue and steer rows go, then its row (its review threads with it). The assistant is never deleted.
   * `deleteBranch` is for its worktree's branch, once worktrees exist (M4).
   */
  readonly delete: (id: TaskId, options: { readonly deleteBranch: boolean }, by: Actor) => Effect.Effect<void, TaskNotFound | Conflict>
}

/** The tasks a request names by id: what it depends on, starts from or merges into. */
const namedBy = (fields: Pick<TaskPatch, "depends_on" | "merges_into" | "start_from">): ReadonlyArray<string> => [
  ...(fields.depends_on ?? []),
  ...(typeof fields.start_from === "object" && fields.start_from?.type === "task" ? [fields.start_from.task_id] : []),
  ...(typeof fields.merges_into === "string" && fields.merges_into.trim() !== "" ? [fields.merges_into.trim()] : []),
]

/** What a change did, for the reactor. */
interface Changed {
  readonly before: Task | null
  readonly after: Task | null
}

/**
 * Tasks (docs/plan/06-server.md, Tasks): every change takes the task's lock, loads it, decides (`decide.ts`), commits in
 * one transaction with its events, and hands the change to the reactor (`Changes`) after the commit.
 */
export class Tasks extends Context.Service<Tasks, TasksShape>()("huntaway-server/tasks/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const db = yield* Db
      const events = yield* Events
      const changes = yield* Changes
      const locks = yield* KeyedLock
      const random = yield* SecureRandom.SecureRandom
      const pens = yield* PenRepo

      const now = Effect.map(DateTime.now, (t) => Timestamp.make(DateTime.formatIso(t)))
      const load = Effect.fnUntraced(function* (id: string) {
        const task = yield* repo.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })
      const offer = (cause: Actor, done: ReadonlyArray<Changed>) =>
        Effect.forEach(done, ({ before, after }) => changes.offer({ _tag: "TaskChanged", before, after, cause }), { concurrency: 1, discard: true })

      /** The tasks a change may name: its project's, and those named by id that aren't. */
      const linkable = Effect.fnUntraced(function* (projectId: Task["project_id"], named: ReadonlyArray<string>) {
        const own = projectId === null ? [] : yield* repo.projectTasks(projectId)
        const others = named.filter((id) => !own.some((t) => t.id === id))
        return [...own, ...(yield* repo.getMany(others))]
      })
      const updateFacts = Effect.fnUntraced(function* (before: Task, patch: TaskPatch) {
        const project: ProjectRef | null = before.project_id === null ? null : yield* repo.project(before.project_id)
        const links = patch.depends_on !== undefined || patch.merges_into !== undefined || patch.start_from !== undefined
        const merge = patch.status === "ready_for_merge"
        const facts: UpdateFacts = {
          project,
          running: false,
          configs: patch.claude_config_id === undefined ? [] : yield* repo.configs(before.profile_id, project),
          tasks: links || merge ? yield* linkable(before.project_id, namedBy(patch)) : [],
          gitWork: false,
          worktreeFolderExists: false,
          startCommit: null,
          prApproval: { _tag: "NotRequired" },
          endOfMergeQueue: merge ? yield* repo.endPosition(before.project_id, "ready_for_merge") : 0,
        }
        return facts
      })

      /** The pen `patch` puts `before` in, made if it names one the profile hasn't; undefined when it asks for none. */
      const resolvePen = Effect.fnUntraced(function* (before: Task, patch: TaskPatch, at: Timestamp) {
        const wanted = yield* Effect.fromResult(penWanted(before, patch))
        if (wanted._tag === "Keep") return undefined
        if (wanted._tag === "Out") return null
        if (wanted._tag === "ById") {
          const pen = yield* pens.get(wanted.id)
          if (pen === null || pen.profile_id !== before.profile_id) return yield* new NotFound({ what: "pen", id: wanted.id })
          return pen.id
        }
        const found = yield* pens.byName(before.profile_id, wanted.name)
        if (found !== null) return found.id
        const id = PenId.make(yield* random.uuidV4())
        const color = nextPenColor((yield* pens.list(before.profile_id)).map((p) => p.color))
        yield* pens.insert({ id, profile_id: before.profile_id, name: wanted.name, active: true, color, now: at })
        yield* events.emit({ type: "pens", profile_id: before.profile_id, pens: yield* pens.list(before.profile_id) })
        return id
      })

      const createFacts = Effect.fnUntraced(function* (input: NewTask) {
        if (input.project_id !== undefined) {
          const project = yield* repo.project(input.project_id)
          if (project === null) return yield* new ProjectNotFound({ id: input.project_id })
          const links = input.depends_on !== undefined || input.merges_into !== undefined || input.start_from !== undefined
          const facts: CreateFacts = {
            place: { _tag: "Project", project },
            configs: yield* repo.configs(project.profile_id, project),
            tasks: links ? yield* linkable(project.id, namedBy(input)) : [],
          }
          return facts
        }
        if (input.profile_id === undefined) return yield* new Invalid({ field: "project_id", reason: "give a project_id, or a profile_id" })
        const profile = yield* repo.profile(input.profile_id)
        if (profile === null) return yield* new ProfileNotFound({ id: input.profile_id })
        const facts: CreateFacts = {
          place:
            input.group === undefined
              ? { _tag: "Scratch", profile_id: profile.id }
              : { _tag: "Group", profile_id: profile.id, group: input.group, projects: yield* repo.groupProjects(profile.id, input.group.trim()) },
          configs: yield* repo.configs(profile.id, null),
          tasks: [],
        }
        return facts
      })

      /** Writes `columns` (with what follows from them) on `before`, emits the task, and returns it as it is now. */
      const commit = Effect.fnUntraced(function* (before: Task, columns: TaskColumns, at: Timestamp) {
        yield* repo.write(before.id, columns, at)
        const after = yield* load(before.id)
        yield* events.emit({ type: "task", task: after })
        return after
      })

      const get = Effect.fn("Tasks.get")(function* (id: TaskId) {
        return yield* load(id)
      })

      const list = Effect.fn("Tasks.list")(function* (filter: TaskFilter) {
        if (filter._tag === "ByProject" && (yield* repo.project(filter.project_id)) === null) return yield* new ProjectNotFound({ id: filter.project_id })
        return yield* repo.list(filter)
      })

      const create = Effect.fn("Tasks.create")(function* (input: NewTask, by: Actor) {
        const at = yield* now
        const id = TaskId.make(yield* random.uuidV4())
        const task = yield* db.tx(
          Effect.gen(function* () {
            const row = yield* Effect.fromResult(decideCreate(input, yield* createFacts(input), at))
            const createdBy = by._tag === "Agent" ? { created_by: by.task_id } : {}
            yield* repo.insert(id, { ...row, columns: { ...row.columns, ...createdBy } }, at)
            // Just inserted, in this transaction.
            const created = yield* load(id).pipe(Effect.orDie)
            yield* events.emit({ type: "task", task: created })
            return created
          }),
        )
        yield* offer(by, [{ before: null, after: task }])
        return task
      })

      const update = Effect.fn("Tasks.update")(function* (id: TaskId, patch: TaskPatch, by: Actor) {
        return yield* locks.withLock(["task", id])(
          Effect.gen(function* () {
            const at = yield* now
            const done = yield* db.tx(
              Effect.gen(function* () {
                const before = yield* load(id)
                const pen = yield* resolvePen(before, patch, at)
                const decision = yield* Effect.fromResult(decideUpdate(before, patch, { ...(yield* updateFacts(before, patch)), pen }, by, at))
                // Nothing to write: nothing changed, and nothing is told.
                if (Object.keys(decision.columns).length === 0) return { before, after: null }
                return { before, after: yield* commit(before, decision.columns, at) }
              }),
            )
            if (done.after === null) return done.before
            yield* offer(by, [done])
            return done.after
          }),
        )
      })

      const change = Effect.fn("Tasks.change")(function* (id: TaskId, decide: (task: Task) => TaskColumns | null, cause: Actor) {
        return yield* locks.withLock(["task", id])(
          Effect.gen(function* () {
            const at = yield* now
            const done = yield* db.tx(
              Effect.gen(function* () {
                const before = yield* load(id)
                const columns = decide(before)
                if (columns === null) return { before, after: null }
                const project = before.project_id === null || columns.pr_url === undefined ? null : yield* repo.project(before.project_id)
                return { before, after: yield* commit(before, deriveColumns(before, columns, at, project?.pr_preview_url ?? null), at) }
              }),
            )
            if (done.after === null) return done.before
            yield* offer(cause, [done])
            return done.after
          }),
        )
      })

      const remove = Effect.fn("Tasks.delete")(function* (id: TaskId, _options: { readonly deleteBranch: boolean }, by: Actor) {
        return yield* locks.withLock(["task", id])(
          Effect.gen(function* () {
            const at = yield* now
            const done = yield* db.tx(
              Effect.gen(function* () {
                const gone = yield* load(id)
                // The profile's assistant lasts: it goes only with its profile.
                if (gone.kind === "task" && gone.task_type === "assistant") {
                  return yield* new Conflict({ reason: "in_use", detail: "the profile's assistant can't be deleted" })
                }
                const reviews = yield* repo.reviewThreads(id)
                const siblings = gone.project_id === null ? [] : yield* repo.projectTasks(gone.project_id)
                const changed: Array<Changed> = []
                for (const { id: other, columns } of decideDeleted(gone, siblings)) {
                  const before = siblings.find((t) => t.id === other)
                  if (before === undefined) continue
                  changed.push({ before, after: yield* commit(before, deriveColumns(before, columns, at), at) })
                }
                yield* repo.delete(id)
                for (const r of [...reviews, gone]) yield* events.emit({ type: "task_deleted", id: r.id, project_id: r.project_id })
                changed.push({ before: gone, after: null })
                return changed
              }),
            )
            yield* offer(by, done)
          }),
        )
      })

      return Tasks.of({ get, list, create, update, change, delete: remove })
    }),
  )
}
