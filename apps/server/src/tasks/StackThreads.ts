import { Context, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, TaskId } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { stackOf, stackThreadHeir } from "./lanes.ts"
import type { Rows } from "./lanes.ts"
import { TaskRepo } from "./TaskRepo.ts"
import { Actor } from "../platform/Changes.ts"
import { TaskNotFound, Tasks } from "./Tasks.ts"

// A stack's own thread (HE-105): one lasting thread per stack, which the user messages to restack it (rebase its levels
// onto each other, force-push them, fix their pull requests' bases) rather than chasing each level's agent, and which its
// levels' agents hand stack work to. It's a task of the stack's project (`task_type` `stack`, keyed and numbered as the
// project's), under the stack's bottom task (`parent_id`), off the board's columns; the Stack card opens it.

/** A stack thread's title, after its stack's: its own title, else its bottom task's. */
export const stackThreadTitle = (bottom: Pick<Task, "title" | "stack_title">): string => `Stack: ${bottom.stack_title?.trim() || bottom.title}`

/** Whether `t` is a stack's own thread. */
export const isStackThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "stack"

/**
 * The thread of the stack whose levels are `levels`, among `rows`: the one under its bottom, else one under another of
 * its levels (left there when the stack grew below it, or its bottom changed). Null when it has none yet.
 */
export const stackThreadOf = (rows: Rows, levels: ReadonlyArray<Pick<Task, "id">>): Task | null => {
  const at = (t: Task) => levels.findIndex((l) => l.id === t.parent_id)
  return rows.filter((t) => isStackThread(t) && at(t) >= 0).toSorted((a, b) => at(a) - at(b))[0] ?? null
}

/** Board order of threads: the oldest first. */
const oldestFirst = (a: Task, b: Task) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)

/** What `settleThreads` decided: threads moved under a stack's bottom, and threads with no stack left to look after. */
export interface Settled {
  readonly moves: ReadonlyArray<{ readonly id: TaskId; readonly to: TaskId }>
  readonly drops: ReadonlyArray<TaskId>
}

/**
 * Where a project's stack threads go after a change of `changed` (the task as it is now; null once deleted), among
 * `rows` (its project's tasks of its profile, the threads too): each stays with the stack its level is in, under that
 * stack's bottom (which changes when a level is put below it). One whose level is in no stack any more follows the part
 * `changed` took with it (a split), if that part has no thread; else it has no stack and goes, as does a second thread
 * of one stack (two stacks joined: the older thread stays).
 */
export const settleThreads = (rows: Rows, changed: Task | null): Settled => {
  const moves: Array<{ readonly id: TaskId; readonly to: TaskId }> = []
  const drops: Array<TaskId> = []
  const claimed = new Set<string>()
  const homeless: Array<Task> = []
  const levelOf = (t: Task) => {
    const parent = rows.find((x) => x.id === t.parent_id && !isStackThread(x))
    return parent === undefined ? null : stackOf(rows, parent)
  }
  for (const t of rows.filter(isStackThread).toSorted(oldestFirst)) {
    const st = levelOf(t)
    if (st === null) homeless.push(t)
    else if (claimed.has(st.bottom.id)) drops.push(t.id)
    else {
      claimed.add(st.bottom.id)
      if (t.parent_id !== st.bottom.id) moves.push({ id: t.id, to: st.bottom.id })
    }
  }
  const split = changed === null || isStackThread(changed) ? null : stackOf(rows, changed)
  for (const t of homeless) {
    if (split !== null && !claimed.has(split.bottom.id)) {
      claimed.add(split.bottom.id)
      moves.push({ id: t.id, to: split.bottom.id })
    } else drops.push(t.id)
  }
  return { moves, drops }
}

/** Whether a change of a task can change which stack a thread's level is in (or where its bottom is). */
const movesStacks = (before: Task | null, after: Task | null): boolean =>
  before === null ||
  after === null ||
  before.start_from !== after.start_from ||
  before.merges_into !== after.merges_into ||
  before.kind !== after.kind ||
  before.project_id !== after.project_id ||
  before.profile_id !== after.profile_id

export interface StackThreadsShape {
  /**
   * The thread of the stack task `id` is in (any level), made the first time it's asked for: in the stack's project,
   * under its bottom, titled after it. Emits `task` when it's made. `Invalid` for a task in no stack, or a stack in no
   * project (it has no repository to restack).
   */
  readonly thread: (id: TaskId) => Effect.Effect<Task, TaskNotFound | Invalid>
  /** The thread of the stack `task` is in, if it has one; never made here. */
  readonly find: (task: Task) => Effect.Effect<Task | null>
  /**
   * The stack threads under `task`, which is about to be deleted, and the level each goes under (`stackThreadHeir`, read
   * now: a merged task's deletion unstacks the levels on it before it's deleted); null when none is left to take them.
   */
  readonly heirOf: (task: Task) => Effect.Effect<{ readonly threads: ReadonlyArray<TaskId>; readonly heir: TaskId | null }>
  /** Moves thread `id` under task `to` (the board's change). */
  readonly moveUnder: (id: TaskId, to: TaskId) => Effect.Effect<void>
  /**
   * The reactor's step for a task's change (made, deleted, or changed in what it starts from or merges into): its
   * project's stack threads moved where `settleThreads` says. The threads with no stack left, for the caller to delete
   * (stopping their runs).
   */
  readonly settle: (before: Task | null, after: Task | null) => Effect.Effect<ReadonlyArray<TaskId>>
}

export class StackThreads extends Context.Service<StackThreads, StackThreadsShape>()("huntaway-server/tasks/StackThreads") {
  static readonly layer = Layer.effect(
    StackThreads,
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const db = yield* Db
      const events = yield* Events
      const random = yield* SecureRandom.SecureRandom
      const tasks = yield* Tasks

      /** A project's tasks of a profile, the threads too. */
      const projectRows = (t: Pick<Task, "project_id" | "profile_id">) =>
        t.project_id === null
          ? Effect.succeed([])
          : Effect.map(repo.projectTasks(t.project_id), (all) => all.filter((x) => x.kind === "task" && x.profile_id === t.profile_id))

      const heirOf = Effect.fn("StackThreads.heirOf")(function* (task: Task) {
        const rows = yield* projectRows(task)
        const threads = rows.filter((t) => isStackThread(t) && t.parent_id === task.id).map((t) => t.id)
        return { threads, heir: threads.length === 0 ? null : (stackThreadHeir(rows, task.id)?.id ?? null) }
      })

      const moveUnder = Effect.fn("StackThreads.moveUnder")(function* (id: TaskId, to: TaskId) {
        yield* tasks.change(id, (t) => (t.parent_id === to ? null : { parent_id: to }), Actor.board).pipe(Effect.ignore)
      })

      const settle = Effect.fn("StackThreads.settle")(function* (before: Task | null, after: Task | null) {
        const task = after ?? before
        if (task === null || (task.kind !== "task" && before?.kind !== "task")) return []
        if (!movesStacks(before, after)) return []
        // Where it was too, when it moved between projects or profiles.
        const places = [after, before].filter((t): t is Task => t !== null && t.project_id !== null)
        const drops: Array<TaskId> = []
        for (const place of places.filter((p, i) => places.findIndex((q) => q.project_id === p.project_id && q.profile_id === p.profile_id) === i)) {
          const rows = yield* projectRows(place)
          if (!rows.some(isStackThread)) continue
          const changed = after !== null && after.project_id === place.project_id && after.profile_id === place.profile_id ? after : null
          const plan = settleThreads(rows, changed === null ? null : (rows.find((r) => r.id === changed.id) ?? null))
          for (const m of plan.moves) yield* moveUnder(m.id, m.to)
          drops.push(...plan.drops)
        }
        return drops
      })

      /** The stack `t` is in, from its project's tasks of its profile, with those tasks. */
      const stackIn = Effect.fnUntraced(function* (t: Task) {
        if (t.project_id === null || t.kind !== "task") return null
        const rows = (yield* repo.projectTasks(t.project_id)).filter((x) => x.kind === "task" && x.profile_id === t.profile_id)
        const stack = stackOf(rows, t)
        return stack === null ? null : { rows, stack }
      })

      const find = Effect.fn("StackThreads.find")(function* (task: Task) {
        const found = yield* stackIn(task)
        return found === null ? null : stackThreadOf(found.rows, found.stack.levels)
      })

      const thread = Effect.fn("StackThreads.thread")(function* (id: TaskId) {
        const asked = yield* repo.get(id)
        if (asked === null) return yield* new TaskNotFound({ id })
        if (isStackThread(asked)) return asked
        const made = yield* db.tx(
          Effect.gen(function* () {
            // Looked for in the transaction that makes it, so two first opens make one.
            const found = yield* stackIn(asked)
            if (found === null) return yield* new Invalid({ field: "id", reason: "the task isn't in a stack" })
            const had = stackThreadOf(found.rows, found.stack.levels)
            if (had !== null) return { task: had, made: false }
            const { bottom } = found.stack
            const project = bottom.project_id === null ? null : yield* repo.project(bottom.project_id)
            if (project === null) return yield* new Invalid({ field: "id", reason: "the stack isn't in a project" })
            const configs = yield* repo.configs(bottom.profile_id, project)
            const threadId = TaskId.make(yield* random.uuidV4())
            yield* repo.insert(
              threadId,
              {
                family: "project",
                profile_id: bottom.profile_id,
                project_id: bottom.project_id,
                generateTitle: false,
                columns: {
                  title: stackThreadTitle(bottom),
                  title_pinned: true,
                  description: "",
                  status: "todo",
                  task_type: "stack",
                  parent_id: bottom.id,
                  use_worktree: false,
                  claude_config_id: configs[0] ?? null,
                },
              },
              yield* nowTimestamp,
            )
            const task = yield* repo.get(threadId)
            if (task === null) return yield* Effect.die(new Error("the stack thread's row is gone"))
            return { task, made: true }
          }),
        )
        if (made.made) yield* events.emit({ type: "task", task: made.task })
        return made.task
      })

      return StackThreads.of({ thread, find, heirOf, moveUnder, settle })
    }),
  )
}
