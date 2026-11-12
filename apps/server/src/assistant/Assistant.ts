import { Context, Effect, Layer, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Conflict, Invalid, NotFound, TaskId, Unavailable } from "@huntaway/contracts"
import type { MemoryCommit, MemoryDiff, MemoryFileContent, MemoryOverview, MemoryWrite, Profile, ProfileId, Task } from "@huntaway/contracts"
import { Questions } from "../permissions/Questions.ts"
import { nowTimestamp, rowsOf } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { formatNumber } from "../prompts/memory.ts"
import { importMessage, MAX_IMPORT } from "./memory/text.ts"
import { Memory } from "./Memory.ts"

// Each profile's assistant (docs/plan/06-server.md, Assistant; inventory 02, section 2.12; huntaway's
// agent/assistant.ts): one long-lived thread in no project, keyed `A-<n>`, that the user talks to from the sidebar. It
// is a task (`task_type` "assistant"), so it has the thread, runs, steering, compaction, prompts and board tools of any
// other, but it works in a workspace of its own (`assistants/<task id>` in the data folder, `Memory`) and never goes to
// review or merge (`tasks/decide.ts` refuses those statuses). It is made the first time it's asked for (`get`), in one
// transaction that looks for it first, so two first opens make one; it goes only with its profile.
//
// A profile can name another host for its assistant (`assistant_host`). Then `get` and `send` are refused here unless
// asked for this host's own (`here`): the hub sends them to that host (`hosts/AssistantHost.ts`, 7.4), asking for its
// own there, and a board that found the assistant's host asks it so. Its memory, Google and brief are refused here
// unless this host has the assistant (`here`), as the old server refused them.

/** The assistant's folder, relative to the data folder (so it moves with it). */
export const workDirOf = (task: TaskId): string => `assistants/${task}`

const IdRow = Schema.Struct({ id: TaskId })
const idRows = rowsOf(IdRow)

/** The profile's assistant and its workspace, ready. */
export interface Opened {
  readonly task: Task
  readonly dir: string
}

type Errors = NotFound | Invalid | Conflict | Unavailable

export interface AssistantShape {
  /**
   * The profile's assistant, made the first time it's asked for (with its workspace and memory files). `Unavailable`
   * when the profile's assistant runs on another host and this one has none, unless `here` (this host's own, whatever
   * the profile says: the old `?local=1`).
   */
  readonly get: (profile: ProfileId, here?: boolean) => Effect.Effect<Task, NotFound | Unavailable>
  /** The profile's assistant, if it has one (none is made). */
  readonly find: (profile: ProfileId) => Effect.Effect<Task | null>
  /** Sends the user's message to the assistant (starting its agent or steering it); a message settles its open questions. */
  readonly send: (profile: ProfileId, text: string, here?: boolean) => Effect.Effect<Task, NotFound | Unavailable | TaskNotFound | SendRefused>
  /**
   * The assistant and its workspace, made ready (checked, seeded, with history). `Conflict` when the profile's assistant
   * runs on another host and this one has none (its memory is there).
   */
  readonly open: (profile: ProfileId) => Effect.Effect<Opened, NotFound | Conflict | Unavailable>
  /** The profile's assistant is on this host: `Conflict` when it runs on another (and this one has none), as `open`. */
  readonly here: (profile: ProfileId) => Effect.Effect<void, NotFound | Conflict>
  readonly memory: (profile: ProfileId) => Effect.Effect<MemoryOverview, Errors>
  readonly memoryFile: (profile: ProfileId, path: string, rev: string | null) => Effect.Effect<MemoryFileContent, Errors>
  readonly writeMemoryFile: (profile: ProfileId, path: string, content: string, expected: string | null, force: boolean) => Effect.Effect<MemoryWrite, Errors>
  readonly memoryHistory: (profile: ProfileId, path: string | null) => Effect.Effect<{ readonly commits: ReadonlyArray<MemoryCommit> }, Errors>
  readonly memoryDiff: (profile: ProfileId, rev: string, path: string | null) => Effect.Effect<MemoryDiff, Errors>
  readonly restoreMemory: (profile: ProfileId, path: string, rev: string) => Effect.Effect<MemoryWrite, Errors>
  /** Sends another assistant's answer to the import prompt to the assistant, as data, to fold into its memory. */
  readonly importMemory: (profile: ProfileId, text: string) => Effect.Effect<Task, Errors | TaskNotFound | SendRefused>
  /**
   * The assistant whose workspace a run of `task` works in: the assistant itself, and a routine thread's assistant (its
   * parent, in the same folder). None for other threads; `Unavailable` for a routine whose assistant or workspace is gone.
   */
  readonly whoseWorkspace: (task: Task) => Effect.Effect<Task | null, Unavailable>
}

export class Assistant extends Context.Service<Assistant, AssistantShape>()("huntaway-server/assistant/Assistant") {
  static readonly layer = Layer.effect(
    Assistant,
    Effect.gen(function* () {
      const db = yield* Db
      const tasks = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const identity = yield* Identity
      const events = yield* Events
      const runs = yield* Runs
      const questions = yield* Questions
      const memory = yield* Memory
      const random = yield* SecureRandom.SecureRandom

      const find = Effect.fn("Assistant.find")(function* (profile: ProfileId) {
        const found = yield* idRows(
          db.sql`SELECT id FROM tasks WHERE profile_id = ${profile} AND kind = 'task' AND task_type = 'assistant' ORDER BY rowid LIMIT 1`,
        )
        return found[0] === undefined ? null : yield* tasks.get(found[0].id)
      })

      const profileOf = Effect.fnUntraced(function* (profile: ProfileId) {
        const p = yield* profiles.get(profile)
        if (Option.isNone(p)) return yield* new NotFound({ what: "profile", id: profile })
        return p.value
      })

      /** Another host this profile's assistant runs on, if it names one. */
      const hostElsewhere = (p: Profile) =>
        p.assistant_host !== null && String(p.assistant_host) !== String(identity.hostId) ? String(p.assistant_host) : null

      /** Made in one transaction that looks for it first, so two first opens make one. */
      const make = Effect.fnUntraced(function* (p: Profile) {
        const id = TaskId.make(yield* random.uuidV4().pipe(Effect.orDie))
        const at = yield* nowTimestamp
        const configs = yield* tasks.configs(p.id, null)
        const config = configs.find((c) => c === p.assistant_config_id) ?? configs[0] ?? null
        const made = yield* db.tx(
          Effect.gen(function* () {
            const there = yield* find(p.id)
            if (there !== null) return { task: there, made: false }
            yield* tasks.insert(
              id,
              {
                family: "assistant",
                profile_id: p.id,
                project_id: null,
                generateTitle: false,
                columns: {
                  title: "Assistant",
                  description: "",
                  status: "todo",
                  use_worktree: false,
                  task_type: "assistant",
                  work_dir: workDirOf(id),
                  // Its title stays: it isn't renamed after the user's prompts.
                  title_pinned: true,
                  claude_config_id: config,
                },
              },
              at,
            )
            const task = yield* tasks.get(id)
            if (task === null) return yield* Effect.die(new Error("the assistant's row is gone"))
            return { task, made: true }
          }),
        )
        if (made.made) yield* events.emit({ type: "task", task: made.task })
        return made.task
      })

      const get = Effect.fn("Assistant.get")(function* (profile: ProfileId, local = false) {
        const p = yield* profileOf(profile)
        let task = yield* find(profile)
        if (task === null) {
          // Its host's (the hub asks it there, `hosts/AssistantHost.ts`), unless this host's own is asked for.
          const elsewhere = local ? null : hostElsewhere(p)
          if (elsewhere !== null) return yield* new Unavailable({ what: "assistant host", reason: `${p.name}'s assistant runs on another host (${elsewhere})` })
          task = yield* make(p)
        }
        // Its workspace with its memory files, made again if it went missing (its history comes with its first run).
        const made = task
        yield* memory.checked(made).pipe(
          Effect.flatMap((dir) => memory.ensure(dir)),
          Effect.catch((e) => Effect.logWarning(`task=${made.id} the assistant's folder: ${e.reason}`)),
        )
        return task
      })

      const send = Effect.fn("Assistant.send")(function* (profile: ProfileId, text: string, local = false) {
        const task = yield* get(profile, local)
        const after = yield* runs.send(task.id, { text, source: "user" })
        // The user's reply answers the questions it asked.
        if (text.trim() !== "") yield* questions.settle(after.id, "replied")
        return after
      })

      const here = Effect.fn("Assistant.here")(function* (profile: ProfileId) {
        const p = yield* profileOf(profile)
        // One this host has is its own, whatever its profile says now.
        const there = yield* find(profile)
        const elsewhere = hostElsewhere(p)
        if (there === null && elsewhere !== null) {
          return yield* new Conflict({ reason: "in_use", detail: `${p.name}'s assistant runs on another host (${elsewhere}): its memory is there` })
        }
        return there
      })

      const open = Effect.fn("Assistant.open")(function* (profile: ProfileId) {
        const there = yield* here(profile)
        const task = there ?? (yield* get(profile))
        const dir = yield* memory.checked(task)
        yield* memory.ensure(dir)
        return { task, dir }
      })

      const importMemory = Effect.fn("Assistant.importMemory")(function* (profile: ProfileId, text: string) {
        if (text.trim() === "") return yield* new Invalid({ field: "text", reason: "paste what the other assistant answered" })
        if (new TextEncoder().encode(text).length > MAX_IMPORT) {
          return yield* new Invalid({ field: "text", reason: `that's more than ${formatNumber(MAX_IMPORT)} characters: paste the most useful part` })
        }
        yield* open(profile)
        return yield* send(profile, importMessage(text))
      })

      const whoseWorkspace = Effect.fn("Assistant.whoseWorkspace")(function* (task: Task) {
        if (task.kind !== "task") return null
        if (task.task_type === "assistant") return task
        if (task.task_type !== "routine") return null
        const parent = task.parent_id === null ? null : yield* tasks.get(task.parent_id)
        if (parent !== null && parent.kind === "task" && parent.task_type === "assistant" && parent.work_dir === task.work_dir) return parent
        return yield* new Unavailable({ what: "assistant workspace", reason: "this routine thread's assistant, or its workspace, is gone" })
      })

      const opened = <A, E>(profile: ProfileId, f: (o: Opened) => Effect.Effect<A, E>) => Effect.flatMap(open(profile), f)

      return Assistant.of({
        get: (profile, local) => get(profile, local),
        find,
        send: (profile, text, local) => send(profile, text, local),
        open,
        here: (profile) => Effect.asVoid(here(profile)),
        memory: (profile) => opened(profile, ({ task, dir }) => memory.overview(task.id, dir)),
        memoryFile: (profile, path, rev) => opened(profile, ({ dir }) => memory.read(dir, path, rev)),
        writeMemoryFile: (profile, path, content, expected, force) => opened(profile, ({ dir }) => memory.write(dir, path, content, expected, force)),
        memoryHistory: (profile, path) => opened(profile, ({ dir }) => Effect.map(memory.history(dir, path), (commits) => ({ commits }))),
        memoryDiff: (profile, rev, path) => opened(profile, ({ dir }) => memory.diff(dir, rev, path)),
        restoreMemory: (profile, path, rev) => opened(profile, ({ dir }) => memory.restore(dir, path, rev)),
        importMemory,
        whoseWorkspace,
      })
    }),
  )
}
