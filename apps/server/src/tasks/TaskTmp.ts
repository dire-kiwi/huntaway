import { Context, Effect, FiberSet, FileSystem, Layer, Schedule, Schema, Semaphore } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { SecureRandom } from "effect/crypto"
import { SqlClient, SqlSchema } from "effect/sql"
import { DataDir } from "../platform/DataDir.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { foldersIn, Leftovers } from "./Leftovers.ts"

// Each task's agents get a temp folder of their own (huntaway's agent/task_tmp.ts), `$TMPDIR` for its runs and
// terminals, so what they leave in it (test servers' data, build output, logs, browsers' profiles) goes with the task
// rather than piling up in /tmp: `<system temp>/ha-<data dir's hash>/<start of the task id>`. A review thread uses the
// folder of the task it reviews, as it works in that task's worktree.
//
// The path is kept short (`/tmp/ha-0123abcd/0123456789ab`) because programs put sockets in their TMPDIR, whose paths
// can't be longer than 107 bytes: Chromium's ProcessSingleton socket is `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`,
// 46 bytes more, and scripts/ui-check.mjs puts the browser's TMPDIR in a folder of its own in the agent's (20 more). A
// folder is named after the first 12 hex digits of its task's id, so it's found by those; two tasks that share them
// (1 in 2^48) share a folder, which goes once both are done.
//
// A task's folder is removed as soon as the task is done and no agent works in it (its own or a reviewer), or when its
// run ends if the task went to Done while it ran, and when the task is deleted; and every `SWEEP`, the folders of tasks
// that are done or deleted (e.g. while the server was down). It's set up again if the task's agent runs again. Each data
// dir has its own root, so a server only ever removes its own tasks' folders, not those of another server (such as a
// test server) on the same machine.
//
// Nothing is removed unless the root is a folder (not a link) of this user's that nobody else can write to, and only
// folders in it named like a task id (or being removed) are. Whether a folder can go is decided, and the folder renamed
// away, under one lock, which `ensure` takes too: as a run is registered (`tasks.running`) before it sets up its folder,
// a run starting meanwhile either keeps the folder or gets a new one.

/** How often the folders of done and deleted tasks are looked for. */
export const SWEEP = "10 minutes"

/** Prefix of a folder being removed: renamed first, so a run starting meanwhile gets a new one. */
export const REMOVING = ".removing-"

/** FNV-1a (64-bit): a hash that stays the same across builds, so a new build finds the folders an older one made. */
export const fnv1a = (bytes: Uint8Array): bigint => {
  let h = 0xcbf29ce484222325n
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
  return h
}

/** The root for data dir `data` in the system's temp folder `temp`. */
export const rootIn = (temp: string, data: string): string => {
  const h = Number(fnv1a(new TextEncoder().encode(data)) & 0xffffffffn)
  return `${temp === "/" ? "" : temp}/ha-${h.toString(16).padStart(8, "0")}`
}

/** The name of task `id`'s folder: the first 12 hex digits of its id (a UUID). */
export const folder = (id: string): string =>
  Array.from(id)
    .filter((c) => /^[A-Za-z0-9]$/.test(c))
    .slice(0, 12)
    .join("")

/** The task whose folder `task`'s agent uses: a review thread's is the task it reviews. */
export const owner = (task: Pick<Task, "id" | "kind" | "parent_id">): TaskId => (task.kind === "review" && task.parent_id !== null ? task.parent_id : task.id)

/** Whether a root entry's name is one of ours: named after a task (see `folder`) or being removed. */
const oursByName = (name: string): boolean => name.startsWith(REMOVING) || (name.length === 12 && /^[0-9a-f]+$/.test(name))

/** A task that shares a folder: whether it's done and whether an agent works in it (its own, or a reviewer's). */
const FolderTask = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  running: Schema.Int,
  reviewing: Schema.Int,
  worktree_path: Schema.NullOr(Schema.String),
})

export interface TaskTmpShape {
  /** The folder all of this server's tasks' temp folders are in. */
  readonly root: string
  /** `task`'s temp folder (made or not). */
  readonly dir: (task: Pick<Task, "id" | "kind" | "parent_id">) => string
  /**
   * Make `task`'s temp folder (readable only by this user) and return it. Null, with a warning logged, if it can't be:
   * the agent then uses the system's temp folder.
   */
  readonly ensure: (task: Pick<Task, "id" | "kind" | "parent_id">) => Effect.Effect<string | null>
  /**
   * `task`'s status or running state changed: once it's done and its agents have stopped, its folder goes, in the
   * background. A review thread's change may be the last of the task's agents stopping. Returns at once.
   */
  readonly changed: (task: Pick<Task, "id" | "kind" | "parent_id" | "status">) => Effect.Effect<void>
  /** Waits until the removals `changed` started have finished: what tests wait on. */
  readonly idle: Effect.Effect<void>
  /** Task `id` has been deleted (with its agents stopped): its folder goes. */
  readonly deleted: (id: TaskId) => Effect.Effect<void>
  /** Remove folder `name` (see `folder`) if it can go, stopping what the task left running first. Returns whether it went. */
  readonly remove: (name: string) => Effect.Effect<boolean>
  /** Remove the folders of tasks that are done (with no agent working in them) or deleted, and any a removal didn't finish. Returns how many went. */
  readonly sweep: Effect.Effect<number>
}

export interface TaskTmpOptions {
  /** For a test: runs once a folder is found removable, before it's renamed away, with the lock held. */
  readonly onRemovable?: Effect.Effect<void>
}

export class TaskTmp extends Context.Service<TaskTmp, TaskTmpShape>()("huntaway-server/tasks/TaskTmp") {
  static readonly make = (options: TaskTmpOptions = {}) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const random = yield* SecureRandom.SecureRandom
      const leftovers = yield* Leftovers
      const lock = yield* Semaphore.make(1)
      const background = yield* FiberSet.make()
      const me = process.geteuid?.() ?? -1

      const root = config.taskTmpRoot ?? rootIn(config.tmpDir, dataDir.root)
      const dir = (task: Pick<Task, "id" | "kind" | "parent_id">) => `${root}/${folder(owner(task))}`

      /**
       * In a temp folder others can write to, the root must be a folder of this user's, not a link someone left there
       * (to make us write to or empty another folder), and no one else may write to it.
       */
      const rootProblem: Effect.Effect<string | null> = fs.lstat(root).pipe(
        Effect.map((m) =>
          m.type !== "Directory" || m.uid._tag === "None" || m.uid.value !== me || (m.mode & 0o022) !== 0
            ? `${root} isn't a folder of this user's that only they can write to`
            : null,
        ),
        Effect.catch((e) => Effect.succeed(e.message)),
      )

      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))

      const ensure = Effect.fn("TaskTmp.ensure")(function* (task: Pick<Task, "id" | "kind" | "parent_id">) {
        const d = dir(task)
        return yield* Effect.gen(function* () {
          yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => e.message))
          const problem = yield* rootProblem
          if (problem !== null) return yield* Effect.fail(problem)
          yield* fs.makeDirectory(d, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => e.message))
          return d
        }).pipe(
          Semaphore.withPermits(lock, 1),
          Effect.catch((reason) => Effect.as(Effect.logWarning(`task ${task.id}: couldn't set up the task's temp folder ${d}: ${reason}`), null)),
        )
      })

      /** The tasks whose folder is `name` (see `folder`): usually one, none once it's deleted. */
      const tasksOf = SqlSchema.findAll({
        Request: Schema.String,
        Result: FolderTask,
        execute: (name) => sql`SELECT t.id, t.status, t.running, t.worktree_path,
            EXISTS (SELECT 1 FROM tasks r WHERE r.parent_id = t.id AND r.kind = 'review' AND r.running = 1) AS reviewing
          FROM tasks t WHERE t.kind != 'review' AND substr(replace(t.id, '-', ''), 1, 12) = ${name}`,
      })

      /** Whether folder `name` can go: its tasks are done (or deleted) and no agent works in them. */
      const removable = (name: string) =>
        tasksOf(name).pipe(
          Effect.map((tasks) => tasks.every((t) => t.status === "done" && t.running === 0 && t.reviewing === 0)),
          Effect.catchCause((cause) => Effect.as(Effect.logWarning(`folder ${name}: reading the tasks of a temp folder`, cause), false)),
        )

      /**
       * Rename folder `name` away, if it can go, under the lock: a run that starts later sets up a new one. Returns where
       * it went, and where it was (by the root's path and its real path, as processes started in it name it).
       */
      const take = (name: string) =>
        Effect.gen(function* () {
          const problem = yield* rootProblem
          if (problem !== null) {
            yield* Effect.logWarning(`not removing anything from the tasks' temp folders: ${problem}`)
            return null
          }
          const from = `${root}/${name}`
          const isDir = yield* fs.lstat(from).pipe(
            Effect.map((m) => m.type === "Directory"),
            Effect.orElseSucceed(() => false),
          )
          // Gone already (another removal got there first), or not one of ours?
          if (!isDir || !(yield* removable(name))) return null
          if (options.onRemovable !== undefined) yield* options.onRemovable
          const away = `${root}/${REMOVING}${name}-${yield* random.uuidV4()}`
          const was = yield* leftovers.variants(from)
          const renamed = yield* fs.rename(from, away).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          return renamed ? { away, from: was } : null
        }).pipe(Semaphore.withPermits(lock, 1))

      /** Makes `d` and the folders in it writable again, not following links out of it. */
      const writable = (d: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* fs.chmod(d, 0o700).pipe(Effect.ignore)
          const entries = yield* fs.readDirectoryEntries(d).pipe(Effect.orElseSucceed(() => []))
          yield* Effect.forEach(
            entries.filter((e) => e.type === "Directory"),
            (e) => writable(`${d}/${e.name}`),
            { concurrency: 1, discard: true },
          )
        })

      /**
       * Remove `d` and all in it, also when something in it took away its folders' write permission (as Go's module
       * cache does), which keeps their contents from being removed.
       */
      const removeAll = (d: string) =>
        fs.remove(d, { recursive: true }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              if (!(yield* exists(d))) return
              yield* writable(d)
              yield* fs.remove(d, { recursive: true })
            }),
          ),
        )

      const remove = Effect.fn("TaskTmp.remove")(function* (name: string) {
        const taken = yield* take(name)
        if (taken === null) return false
        const { away, from } = taken
        // The test servers its agents left running (and their agents), which would run on with their data gone. Also by
        // where the folder went: a server started in it with a relative `--data-dir` names it by its working directory,
        // which moved.
        yield* Effect.gen(function* () {
          const worktrees = (yield* tasksOf(name)).flatMap((t) => (t.worktree_path !== null ? [t.worktree_path] : []))
          yield* leftovers.stopTask({ tmp: [...from, away], worktrees, data_dir: dataDir.root, tmp_root: root }, `folder ${name}`)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning(`folder ${name}: stopping what the task left running`, cause)))
        yield* removeAll(away).pipe(
          Effect.andThen(Effect.logInfo(`folder ${name}: removed a task's temp folder`)),
          Effect.catchCause((cause) => Effect.logWarning(`folder ${name}: removing a task's temp folder`, cause)),
        )
        return true
      })

      const changed = Effect.fn("TaskTmp.changed")(function* (task: Pick<Task, "id" | "kind" | "parent_id" | "status">) {
        if (task.kind === "task" && task.status !== "done") return
        const name = folder(owner(task))
        if (!(yield* exists(`${root}/${name}`))) return
        yield* FiberSet.run(background, remove(name))
      })

      const deleted = Effect.fn("TaskTmp.deleted")(function* (id: TaskId) {
        yield* remove(folder(id))
      })

      /**
       * Stop the test servers (and their agents) whose data dirs are in folders of done or deleted tasks that have gone
       * already: removed by a server from before it stopped them first, or by hand. Those whose folder is still there
       * are stopped as it's removed.
       */
      const stopOrphans = Effect.gen(function* () {
        const roots = yield* leftovers.variants(root)
        const procs = yield* leftovers.list
        if (procs === null) return
        for (const name of foldersIn(procs, roots)) {
          if (yield* exists(`${root}/${name}`)) continue
          const tasks = yield* tasksOf(name).pipe(Effect.orElseSucceed(() => null))
          if (tasks === null || !tasks.every((t) => t.status === "done" && t.running === 0)) continue
          const scope = { tmp: roots.map((x) => `${x}/${name}`), worktrees: [], data_dir: dataDir.root, tmp_root: root }
          // Listed again for each folder: stopping the last one's may have taken seconds, in which pids are reused.
          yield* leftovers.stopTask(scope, `folder ${name} (gone)`)
        }
      })

      const sweep = Effect.gen(function* () {
        let n = 0
        // With the whole root gone (removed by hand), there's nothing to remove, but what ran in its folders may still run.
        if (yield* exists(root)) {
          const problem = yield* rootProblem
          if (problem !== null) {
            yield* Effect.logWarning(`not sweeping the tasks' temp folders: ${problem}`)
            return 0
          }
          const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => null))
          if (entries === null) return 0
          for (const e of entries) {
            if (e.type !== "Directory" || !oursByName(e.name)) continue
            if (e.name.startsWith(REMOVING)) yield* removeAll(`${root}/${e.name}`).pipe(Effect.ignore)
            else if (yield* remove(e.name)) n++
          }
        }
        yield* stopOrphans.pipe(Effect.catchCause((cause) => Effect.logWarning("stopping what done tasks left running", cause)))
        return n
      }).pipe(Effect.withSpan("TaskTmp.sweep"))

      return TaskTmp.of({ root, dir, ensure, changed, idle: FiberSet.awaitEmpty(background), deleted, remove, sweep })
    }).pipe(Effect.annotateLogs({ module: "task-tmp" }))

  static readonly layer = Layer.effect(TaskTmp, TaskTmp.make())

  /** The sweeper (docs/plan/06-server.md, Startup step 4): now, then every `SWEEP`, for as long as the server runs. */
  static readonly sweeper = Layer.effectDiscard(
    Effect.gen(function* () {
      const tmp = yield* TaskTmp
      const tick = tmp.sweep.pipe(
        Effect.tap((n) => (n > 0 ? Effect.logInfo(`removed ${n} done or deleted tasks' temp folders`) : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("sweeping the tasks' temp folders", cause)),
        Effect.annotateLogs({ module: "task-tmp" }),
      )
      yield* tick.pipe(Effect.repeat(Schedule.spaced(SWEEP)), Effect.forkScoped)
    }),
  )
}
