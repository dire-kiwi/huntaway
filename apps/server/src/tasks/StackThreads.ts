import { Context, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, TaskId } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { sameStart } from "./decide.ts"
import { stackOf, stackState, stackThreadHeir } from "./lanes.ts"
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
 * Whether stack level `t` is held until the user says where it goes: the level below it was deleted, or closed without
 * being merged (`stackState`), and it isn't done. Its stack's thread waits under it meanwhile.
 */
export const heldLevel = (rows: Rows, t: Task): boolean => {
  if (t.status === "done") return false
  const st = stackState(rows, t)
  return st === "deleted" || st === "closed"
}

/** A level's group: its stack's levels, or just it while it's held (`heldLevel`); null for a task in neither. */
const groupOf = (rows: Rows, t: Task): ReadonlyArray<Task> | null => stackOf(rows, t)?.levels ?? (heldLevel(rows, t) ? [t] : null)

/** The stack threads under any of `levels`, the oldest first. */
const threadsUnder = (rows: Rows, levels: ReadonlyArray<Pick<Task, "id">>): Array<Task> =>
  rows.filter((t) => isStackThread(t) && levels.some((l) => l.id === t.parent_id)).toSorted(oldestFirst)

/**
 * Where the stack threads a change of a task touches go (`before` and `after` the change, null when it was made or
 * deleted), among `rows` (its project's tasks of its profile as they are now, the threads too). Only the threads of the
 * stack the task was in before the change (read from `rows` with the task as it was, so a change the reactor comes to
 * late decides as it would have) and of the one it's in now are touched. Each stays with its stack, under its bottom
 * (which changes when a level is put below it), or under a level held on a deleted or closed level below (`heldLevel`)
 * until the user says where it goes. One whose part of the old stack has neither follows another part that has one and
 * no thread (a split, a deleted middle level); with none, it goes. Two threads in one stack (two stacks joined): the
 * older stays and the other goes.
 */
export const settleThreads = (rows: Rows, before: Task | null, after: Task | null): Settled => {
  const changed = after ?? before
  if (changed === null || isStackThread(changed)) return { moves: [], drops: [] }
  const real = (id: string) => rows.find((r) => r.id === id && !isStackThread(r)) ?? null
  /** Where a thread of `level`'s stack goes now: its stack's bottom, or the level itself while held; null for none. */
  const homeOf = (id: string): TaskId | null => {
    const level = real(id)
    return level === null ? null : (stackOf(rows, level)?.bottom.id ?? (heldLevel(rows, level) ? level.id : null))
  }
  const parent = new Map<TaskId, TaskId | null>(rows.filter(isStackThread).map((t) => [t.id, t.parent_id]))
  const moves: Array<{ readonly id: TaskId; readonly to: TaskId }> = []
  const drops: Array<TaskId> = []
  const move = (t: TaskId, to: TaskId) => {
    if (parent.get(t) !== to) moves.push({ id: t, to })
    parent.set(t, to)
  }
  /** The live threads (not dropped) whose level's home is `home`, as moved so far. */
  const threadsAt = (home: TaskId) => [...parent].filter(([t, p]) => !drops.includes(t) && p !== null && homeOf(p) === home).map(([t]) => t)

  // The stack it was in before the change, with the task as it was.
  const then = [...rows.filter((r) => r.id !== changed.id), ...(before === null ? [] : [before])]
  const old = before === null ? null : groupOf(then, before)
  if (old !== null) {
    const ours = threadsUnder(rows, old)
    const homes = [...new Set(old.map((l) => homeOf(l.id)).filter((h): h is TaskId => h !== null))]
    const claimed = new Set<TaskId>()
    // Not claimed by one of these this round, nor home to a thread of another stack's.
    const free = (h: TaskId) => !claimed.has(h) && threadsAt(h).every((o) => ours.some((x) => x.id === o))
    for (const t of ours) {
      const own = t.parent_id === null ? null : homeOf(t.parent_id)
      const home = own !== null && free(own) ? own : homes.find(free)
      if (home === undefined || home === null) drops.push(t.id)
      else {
        claimed.add(home)
        move(t.id, home)
      }
    }
  }
  // Two stacks joined: the stack it's in now keeps its older thread.
  const now = after === null ? null : real(after.id)
  const home = now === null ? null : homeOf(now.id)
  if (home !== null) {
    const threads = threadsAt(home)
      .map((id) => rows.find((r) => r.id === id))
      .filter((t): t is Task => t !== undefined)
      .toSorted(oldestFirst)
    for (const t of threads.slice(1)) drops.push(t.id)
    if (threads[0] !== undefined) move(threads[0].id, home)
  }
  return { moves, drops }
}

/**
 * Whether a change of a task can change which stack a thread's level is in, where its bottom is, or whether a level is
 * held (done or not).
 */
const movesStacks = (before: Task | null, after: Task | null): boolean =>
  before === null ||
  after === null ||
  !sameStart(before.start_from, after.start_from) ||
  before.merges_into !== after.merges_into ||
  before.kind !== after.kind ||
  before.project_id !== after.project_id ||
  before.profile_id !== after.profile_id ||
  (before.status === "done") !== (after.status === "done")

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
          const here = (t: Task | null) => (t !== null && t.project_id === place.project_id && t.profile_id === place.profile_id ? t : null)
          const plan = settleThreads(rows, here(before), here(after))
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
