import { Context, Effect, Layer, Schema } from "effect"
import type { ProfileId, Task } from "@huntaway/contracts"
import { isAssistants } from "./checks.ts"
import { TaskRepo } from "./TaskRepo.ts"
import type { ProfileRef } from "./TaskRepo.ts"
import { TaskNotFound } from "./Tasks.ts"

/** A key that names a task on more than one profile's board, or two tasks of projects that once shared a key. */
export class TaskRefAmbiguous extends Schema.TaggedError<TaskRefAmbiguous, { readonly brand: unique symbol }>()("TaskRefAmbiguous", {
  ref: Schema.String,
  /** How to name each of them instead: `<profile>:<key>`, or an id. */
  candidates: Schema.Array(Schema.String),
}) {}

export interface Within {
  /** The caller's own profile (an agent's): its board is looked at first, and only its own assistant is reached. */
  readonly own?: ProfileId | undefined
  /** The profiles whose boards the caller may use; unset is every profile's. */
  readonly profiles?: ReadonlyArray<ProfileId> | undefined
}

export interface TaskRefsShape {
  /**
   * The task `ref` names: its id; its key (`HE-2`, in any case), by its project's key or one the project had before, or
   * `G-n`, `S-n`, `A-n` for a profile's tasks in no project; either as `<profile>:<ref>`. Without a profile, a key found
   * on several boards is the caller's own board's, else ambiguous.
   */
  readonly resolve: (ref: string, within?: Within) => Effect.Effect<Task, TaskNotFound | TaskRefAmbiguous>
}

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Finding a task by what a person, an agent or the CLI calls it (huntaway's mcp/tools/resolve.ts `resolve_task`). */
export class TaskRefs extends Context.Service<TaskRefs, TaskRefsShape>()("huntaway-server/tasks/TaskRefs") {
  static readonly layer = Layer.effect(
    TaskRefs,
    Effect.gen(function* () {
      const repo = yield* TaskRepo

      /** The task with key `key-n` on board `b`, or why it can't be told. */
      const onBoard = Effect.fnUntraced(function* (b: ProfileRef, key: string, n: number, within: Within) {
        if (sameText(key, "G")) return yield* repo.projectlessByNumber(b.id, "group", n)
        if (sameText(key, "S")) return yield* repo.projectlessByNumber(b.id, "scratch", n)
        // A profile's assistant is its own: other profiles' agents can't reach it, nor its routine threads.
        if (sameText(key, "A")) return within.own === undefined || within.own === b.id ? yield* repo.projectlessByNumber(b.id, "assistant", n) : null
        // A key a project had before still names its tasks. No other project can take it, so more than one is from
        // before that, and naming either would be a guess.
        const projects = (yield* repo.projects).filter((p) => p.profile_id === b.id && (sameText(p.key, key) || p.former_keys.some((f) => sameText(f, key))))
        const here: Array<Task> = []
        for (const p of projects) {
          const t = yield* repo.byNumber(p.id, n)
          if (t !== null) here.push(t)
        }
        if (here.length > 1) return yield* new TaskRefAmbiguous({ ref: `${key}-${n}`, candidates: here.map((t) => t.id) })
        return here[0] ?? null
      })

      const resolve = Effect.fn("TaskRefs.resolve")(function* (ref: string, within: Within = {}) {
        const text = ref.trim()
        const profiles = yield* repo.profiles
        let boards = within.profiles === undefined ? profiles : profiles.filter((p) => within.profiles?.includes(p.id) === true)
        let rest = text
        // `work:SD-3`, if a profile here is called `work`. Ids and keys have no colons.
        const colon = text.indexOf(":")
        if (colon > 0) {
          const name = text.slice(0, colon)
          const named = profiles.find((p) => sameText(p.name, name) || p.id === name)
          if (named !== undefined) {
            rest = text.slice(colon + 1).trim()
            boards = boards.filter((b) => b.id === named.id)
          }
        }
        // An agent reaches tasks, not the threads under them, and only its own profile's assistant.
        const reaches = (t: Task) =>
          boards.some((b) => b.id === t.profile_id) && (within.own === undefined || (t.kind === "task" && (!isAssistants(t) || t.profile_id === within.own)))
        const byId = yield* repo.get(rest)
        if (byId !== null && reaches(byId)) return byId

        const dash = rest.lastIndexOf("-")
        const key = rest.slice(0, dash)
        const n = rest.slice(dash + 1)
        if (dash <= 0 || !/^[+-]?\d+$/.test(n)) return yield* new TaskNotFound({ id: ref })
        const found: Array<readonly [ProfileRef, Task]> = []
        for (const b of boards) {
          const t = yield* onBoard(b, key, Number(n), within)
          if (t !== null) found.push([b, t])
        }
        const own = found.find(([b]) => b.id === within.own)
        if (own !== undefined) return own[1]
        const [one, ...more] = found
        if (one === undefined) return yield* new TaskNotFound({ id: ref })
        if (more.length > 0) return yield* new TaskRefAmbiguous({ ref, candidates: found.map(([b]) => `${b.name}:${rest}`) })
        return one[1]
      })

      return TaskRefs.of({ resolve })
    }),
  )
}
