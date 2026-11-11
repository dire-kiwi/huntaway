import { Context, DateTime, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore, Stream } from "effect"
import { DocumentLabel, TaskId } from "@huntaway/contracts"
import type { Task, TaskDocument, Timestamp } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TurnHooks } from "../runs/TurnHooks.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { TaskDocumentRepo } from "./TaskDocumentRepo.ts"

// A task's documents (docs/plan/06-server.md, Documents and docs; inventory 02, section 2.7; huntaway's
// agent/documents.ts): a task's labels each ask its agent for a document besides its other work, an HTML page (a plan
// to iterate on, or an artifact) or a Mermaid diagram. The agent writes each to a file in the task's own folder
// (`<data>/documents/<task>`), and the board keeps each version in the `documents` table and shows it in a tab of the
// task (`tasks.document`).
//
// A version follows the file while the agent's turn goes on (`follow`, after each tool call), so the task shows the
// document as it's written, and is closed when the turn ends (`turnEnded`, at a turn's or a run's end): the next change
// starts a new version, so there's one per turn that changed it. Both come through `TurnHooks` (`registered`). What the
// prompts tell the agent is `agents/Prompts` (`prompts/labels.ts` and the guides); `/plan` is `runs/Runs`; writing the
// folder without asking is `Permissions`.

/** A bigger file isn't kept, so a runaway agent can't fill the database. */
export const MAX_SIZE = 5 << 20

/** The file a task with each label writes its document to, in its folder. */
export const DOCUMENT_FILE: { readonly [L in DocumentLabel]: string } = { plan: "plan.html", artifact: "artifact.html", diagram: "diagram.mmd" }

/** The task's labels that ask for a document, in the order the task shows them. */
export const labelsOf = (task: Pick<Task, "kind" | "labels">): ReadonlyArray<DocumentLabel> =>
  task.kind === "task" ? DocumentLabel.literals.filter((l) => task.labels.includes(l)) : []

/** The host's date (`YYYY-MM-DD`, in its time zone) at `at`. */
export const localDay = (at: DateTime.DateTime): string => {
  const p = DateTime.toParts(DateTime.setZone(at, DateTime.zoneMakeLocal()))
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`
}

/** A file kept as a document. `daily`: a change goes into the day's version (one made today, in the host's time zone). */
export interface KeepOptions {
  readonly endOfTurn: boolean
  readonly daily?: boolean | undefined
}

export class VersionNotFound extends Schema.TaggedError<VersionNotFound, { readonly brand: unique symbol }>()("VersionNotFound", {
  id: Schema.String,
  version: Schema.Int,
}) {}

export interface TaskDocumentsShape {
  /** The task's own folder, which holds its documents. */
  readonly folder: (task: TaskId) => string
  /** During a turn, after a tool call: keep the task's documents that the agent changed. */
  readonly follow: (task: TaskId) => Effect.Effect<void>
  /** At the end of a turn (or of the run): keep the documents that changed, and close their versions. */
  readonly turnEnded: (task: TaskId) => Effect.Effect<void>
  /**
   * Keep `file` as the task's document `label` if it changed (whether it did), without the task's `document_at`: for a
   * document that isn't a label's (the assistant's brief, 6.7, `daily`).
   */
  readonly keepFile: (task: TaskId, label: string, file: string, options: KeepOptions) => Effect.Effect<boolean>
  /**
   * A version of the task's document for `label` (its first label's unless given; the latest version unless given), and
   * the list of its versions.
   */
  readonly get: (task: TaskId, label?: DocumentLabel, version?: number) => Effect.Effect<TaskDocument, TaskNotFound | VersionNotFound>
  /** A deleted task's folder goes (its versions went with its row). */
  readonly removed: (task: TaskId) => Effect.Effect<void>
  /** The folders of tasks that are gone (a deleted project's), removed. */
  readonly sweep: Effect.Effect<void>
}

export class TaskDocuments extends Context.Service<TaskDocuments, TaskDocumentsShape>()("huntaway-server/docs/TaskDocuments") {
  static readonly layer = Layer.effect(
    TaskDocuments,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* TaskDocumentRepo
      const tasks = yield* TaskRepo
      const threads = yield* Threads
      const events = yield* Events
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      // The size and modification time each document file had when last looked at, by task and label
      // (`<task>\0<label>`), so following it during a turn doesn't read an unchanged file again. Lost on a restart (the
      // first look reads it again; the content compare keeps that from making a version).
      const seen = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
      // One keep at a time, as the old server's (synchronous) ones were: a turn's end can't interleave with a follow.
      const one = yield* Semaphore.make(1)

      const folder = (task: TaskId) => dataDir.documents(task)

      /** Keep the document `label` from `file` if it changed: whether it did. */
      const keepOne = Effect.fnUntraced(function* (task: TaskId, label: string, file: string, options: KeepOptions) {
        const daily = options.daily === true
        const info = Option.getOrUndefined(yield* Effect.option(fs.stat(file)))
        const size = info === undefined ? null : Number(info.size)
        const modified = info === undefined ? null : Option.getOrNull(info.mtime)
        const stamp = info === undefined ? null : `${size}:${modified?.getTime() ?? ""}`
        const key = `${task}\u0000${label}`
        const before = yield* Ref.getAndUpdate(seen, (all) => {
          const next = new Map(all)
          if (stamp === null) next.delete(key)
          else next.set(key, stamp)
          return next
        })
        if (stamp !== null && before.get(key) === stamp && !options.endOfTurn) return false
        let content: string | null = null
        if (size !== null && size > MAX_SIZE) {
          if (options.endOfTurn) {
            const name = file.slice(file.lastIndexOf("/") + 1)
            yield* threads.notice(task, "warning", `${name} is over ${MAX_SIZE >> 20} MB, so this version isn't kept`).pipe(Effect.ignore)
          }
        } else if (size !== null) content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
        if (content === null) return false
        const text = content
        const now = yield* DateTime.now
        const at = yield* nowTimestamp
        const today = localDay(now)
        return yield* db.tx(
          Effect.gen(function* () {
            if (!(yield* tasks.exists(task))) return false
            const latest = yield* repo.latest(task, label)
            const open = latest !== null && (latest.open || (daily && localDay(DateTime.makeUnsafe(latest.created_at)) === today))
            // A daily document written today, the same as the last day's (the same starred mail, say), is today's version
            // all the same; a file left as it was isn't, as its time says.
            const writtenToday = daily && modified !== null && localDay(DateTime.makeUnsafe(modified)) === today
            if (latest !== null && latest.content === text && (open || !writtenToday)) return false
            // The turn's version follows the file.
            if (latest !== null && open) yield* repo.update(task, label, latest.version, text, !options.endOfTurn, at)
            else yield* repo.insert(task, label, latest === null ? 1 : latest.version + 1, text, !options.endOfTurn, at)
            return true
          }),
        )
      })

      /** The task's `document_at`, now, published. */
      const touched = (task: TaskId, at: Timestamp) =>
        db.tx(
          Effect.gen(function* () {
            yield* tasks.write(task, { document_at: at }, at)
            const after = yield* tasks.get(task)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )

      const keep = (task: TaskId, endOfTurn: boolean) =>
        Effect.gen(function* () {
          const t = yield* tasks.get(task)
          if (t === null) return
          let changed = false
          for (const label of labelsOf(t)) changed = (yield* keepOne(task, label, `${folder(task)}/${DOCUMENT_FILE[label]}`, { endOfTurn })) || changed
          // A label taken off during the turn leaves its version as it was, closed.
          if (endOfTurn) yield* repo.close(task)
          if (changed) yield* touched(task, yield* nowTimestamp)
        }).pipe(Semaphore.withPermits(one, 1))

      const get = Effect.fn("TaskDocuments.get")(function* (id: TaskId, asked?: DocumentLabel, askedVersion?: number) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const label = asked ?? labelsOf(task)[0] ?? "plan"
        const versions = yield* repo.versions(id, label)
        const version = askedVersion ?? versions.at(-1)?.version ?? null
        const content = version === null ? null : yield* repo.content(id, label, version)
        if (askedVersion !== undefined && content === null) return yield* new VersionNotFound({ id, version: askedVersion })
        const doc: TaskDocument = { label, file: `${folder(id)}/${DOCUMENT_FILE[label]}`, versions, version: content === null ? null : version, content }
        return doc
      })

      const removed = Effect.fn("TaskDocuments.removed")(function* (task: TaskId) {
        yield* Ref.update(seen, (all) => new Map([...all].filter(([k]) => !k.startsWith(`${task}\u0000`))))
        yield* fs
          .remove(folder(task), { recursive: true, force: true })
          .pipe(Effect.catch((e) => Effect.logWarning(`task=${task} removing the task's document folder failed: ${e.message}`)))
      })

      const sweep = Effect.gen(function* () {
        const root = `${dataDir.root}/documents`
        const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        for (const name of names) if (!(yield* tasks.exists(name))) yield* removed(TaskId.make(name))
      }).pipe(Effect.withSpan("TaskDocuments.sweep"))

      return TaskDocuments.of({
        folder,
        follow: (task) => keep(task, false).pipe(Effect.withSpan("TaskDocuments.follow")),
        turnEnded: (task) => keep(task, true).pipe(Effect.withSpan("TaskDocuments.turnEnded")),
        keepFile: (task, label, file, options) => keepOne(task, label, file, options).pipe(Semaphore.withPermits(one, 1)),
        get,
        removed,
        sweep,
      })
    }),
  )

  /**
   * The documents follow the runs (`TurnHooks`), and go with their task: a deleted task's folder at once, a deleted
   * project's tasks' by a sweep of the folders whose task is gone.
   */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const hooks = yield* TurnHooks
      yield* hooks.register({ toolDone: documents.follow, turnEnded: documents.turnEnded })
      const watching = yield* (yield* Events).watch(undefined)
      yield* watching.live.pipe(
        Stream.runForEach((e) => (e.type === "task_deleted" ? documents.removed(e.id) : e.type === "project_deleted" ? documents.sweep : Effect.void)),
        Effect.forkScoped,
      )
    }),
  )
}
