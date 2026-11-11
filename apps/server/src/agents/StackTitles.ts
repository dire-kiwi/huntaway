import { Clock, Context, Effect, FiberMap, FiberSet, Layer, Option, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { stackTitle } from "../prompts/stackTitle.ts"
import { stackedBelow, stackedOn, stackOf } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { SideCalls } from "./SideCalls.ts"
import { StackTitleRepo } from "./StackTitleRepo.ts"
import { parseStackReply, stackInput } from "./stackTitles/text.ts"
import { TitleModel } from "./TitleModel.ts"

// A stack's title and description (HA-387; huntaway's agent/stack_title.ts): what a whole stack of tasks is for
// (`tasks/lanes.ts` `stackOf`), kept on the stack's bottom task (`stack_title`, `stack_description`, `stack_pinned`) and
// written by the model task titles are written by (`TitleModel`, with the bottom's config), from the levels' titles and
// descriptions in landing order.
//
// - `changed` is the reactor's step for each `TaskChanged` that may change a stack (its levels, their titles and
//   descriptions, a task made, reopened or deleted): it moves the fields to the stack's bottom at once, should that have
//   changed (`settle`), and has them written again after a pause of five seconds on the clock (levels are often made in a
//   row, descriptions edited in bursts), a new change of the stack starting the pause again (a `FiberMap` by bottom).
// - They're written one at a time (a semaphore), and only when what they'd be written from isn't what they were last
//   written from (the hidden `stack_input` column, `StackTitleRepo`); never while pinned (edited by hand), nor for a stack
//   whose tasks are all done, unless asked (`update` with `regenerate`).
// - A deleted task's fields go to the stack's new bottom (the `TaskChanged` of its deletion still has the row).

/** Why a stack's title can't be changed as asked: a task in no stack, an edit that isn't one. */
export class StackInvalid extends Schema.TaggedError<StackInvalid, { readonly brand: unique symbol }>()("StackInvalid", {
  field: Schema.String,
  reason: Schema.String,
}) {}

/** What `update` is given (the old `PATCH /tasks/{id}/stack`). */
export interface StackEdit {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly regenerate?: boolean | undefined
}

type TaskChanged = Extract<Change, { readonly _tag: "TaskChanged" }>

/** The stack fields a task holds (as its bottom, or as one before). */
interface Fields {
  readonly stack_title: string | null
  readonly stack_description: string | null
  readonly stack_pinned: boolean
  readonly stack_input: string | null
}
const NONE: Fields = { stack_title: null, stack_description: null, stack_pinned: false, stack_input: null }

/** How long a stack's levels are left to settle before it's written (ms), and how long after a start `resume` looks. */
export const STACK_DEBOUNCE_MS = 5_000
export const STACK_RESUME = "60 seconds"

/** A change to one of these may change a stack's levels or what they say. */
const watched = (a: Task, b: Task) =>
  a.title !== b.title ||
  a.description !== b.description ||
  a.status !== b.status ||
  a.kind !== b.kind ||
  a.merges_into !== b.merges_into ||
  (a.start_from?.type === "task" ? a.start_from.task_id : null) !== (b.start_from?.type === "task" ? b.start_from.task_id : null)

const chars = (s: string) => Array.from(s).length
/** Trimmed, or null when blank. */
const blank = (s: string) => (s.trim() === "" ? null : s.trim())

/** Whether task `t` holds a stack's fields (`input`: its hidden `stack_input`). */
const holds = (t: Task, input: string | null) => t.stack_title !== null || t.stack_description !== null || t.stack_pinned || input !== null
const fieldsOf = (t: Task, input: string | null): Fields => ({
  stack_title: t.stack_title,
  stack_description: t.stack_description,
  stack_pinned: t.stack_pinned,
  stack_input: input,
})

/** What's scheduled and under way: stacks waiting for their pause, stacks queued to be written (with `force`), writes going. */
interface Busy {
  readonly timers: ReadonlySet<TaskId>
  readonly queued: ReadonlyMap<TaskId, boolean>
  readonly writing: number
}

export interface StackTitlesShape {
  /** The reactor's step for a task's change: settle the stacks it touches, and write their titles after the pause. */
  readonly changed: (change: TaskChanged) => Effect.Effect<void>
  /**
   * The title and description of the stack `id` is in (any of its tasks), kept on its bottom: `title` and `description`
   * set by hand, which pins them; `regenerate` unpins them and has the model write both again. The bottom.
   */
  readonly update: (id: TaskId, edit: StackEdit) => Effect.Effect<Task, TaskNotFound | StackInvalid>
  /** At a start, after a minute (on the clock, in the background): the open stacks not written from what their levels say now. */
  readonly resume: Effect.Effect<void>
  /** For tests: waits until no stack waits for its pause, is queued, or is being written (move the clock past the pause first). */
  readonly settled: Effect.Effect<void>
}

export class StackTitles extends Context.Service<StackTitles, StackTitlesShape>()("huntaway-server/agents/StackTitles") {
  static readonly layer = Layer.effect(
    StackTitles,
    Effect.gen(function* () {
      const tasks = yield* Tasks
      const repo = yield* TaskRepo
      const inputs = yield* StackTitleRepo
      const configs = yield* AgentConfigRepo
      const model = yield* TitleModel
      const sideCalls = yield* SideCalls
      const timers = yield* FiberMap.make<TaskId>()
      const writers = yield* FiberSet.make()
      const one = yield* Semaphore.make(1)
      const busy = yield* SubscriptionRef.make<Busy>({ timers: new Set(), queued: new Map(), writing: 0 })
      const board = Actor.board

      /** The tasks a stack of `t`'s could have: its project's (or its profile's in no project), of its profile. */
      const rowsOf = Effect.fnUntraced(function* (t: Task) {
        const all = t.project_id === null ? yield* repo.list({ _tag: "Projectless", profile_id: t.profile_id }) : yield* repo.projectTasks(t.project_id)
        return all.filter((x) => x.kind === "task" && x.profile_id === t.profile_id && x.project_id === t.project_id)
      })

      const inputOf = Effect.fnUntraced(function* (id: TaskId) {
        return (yield* inputs.inputs([id])).get(id) ?? null
      })

      /** Write `f` on task `id`: the task's columns, and what they were written from. The task after. */
      const write = Effect.fnUntraced(function* (id: TaskId, f: Fields) {
        const after = yield* tasks
          .change(id, () => ({ stack_title: f.stack_title, stack_description: f.stack_description, stack_pinned: f.stack_pinned }), board)
          .pipe(Effect.option)
        yield* inputs.setInput(id, f.stack_input)
        return Option.getOrNull(after)
      })

      /**
       * Put `t`'s stack's fields on its bottom, and clear them on the stack's other tasks (which held them as bottoms
       * before): the bottom's own if pinned, else the first pinned ones, else the bottom's own if it has any, else the
       * first in landing order. A task in no stack has them cleared, and they go in `dropped` (if given), for the caller
       * to hand to the stack split off from it. The stack's bottom, if it's in one.
       */
      const settle = Effect.fnUntraced(function* (t: Task, dropped: { fields: Fields | null } | null = null) {
        const rows = yield* rowsOf(t)
        const now = rows.find((x) => x.id === t.id) ?? t
        const st = stackOf(rows, now)
        if (st === null) {
          const input = yield* inputOf(now.id)
          if (holds(now, input)) {
            if (dropped !== null) dropped.fields = fieldsOf(now, input)
            yield* write(now.id, NONE)
          }
          return null
        }
        const held = yield* inputs.inputs(st.levels.map((x) => x.id))
        const others = st.levels.filter((x) => x.id !== st.bottom.id && holds(x, held.get(x.id) ?? null))
        if (others.length === 0) return st.bottom
        const all = [st.bottom, ...others]
        const from = all.find((x) => x.stack_pinned) ?? (holds(st.bottom, held.get(st.bottom.id) ?? null) ? st.bottom : others[0])
        for (const x of others) yield* write(x.id, NONE)
        if (from === undefined || from.id === st.bottom.id) return st.bottom
        return (yield* write(st.bottom.id, fieldsOf(from, held.get(from.id) ?? null))) ?? st.bottom
      })

      /** Give stack `bottom` the fields a split dropped (see `settle`), unless it has its own. The bottom as it is then. */
      const handOn = Effect.fnUntraced(function* (bottom: Task, dropped: { fields: Fields | null }) {
        if (dropped.fields === null || holds(bottom, yield* inputOf(bottom.id))) return bottom
        const t = (yield* write(bottom.id, dropped.fields)) ?? bottom
        dropped.fields = null
        return t
      })

      // ---- writing -------------------------------------------------------------------------------------------------

      /** The config the bottom's agent runs with (as `Titles` picks it): its own, else its project's or profile's first. */
      const configOf = Effect.fnUntraced(function* (task: Task) {
        if (task.claude_config_id !== null) {
          const own = yield* configs.get(task.claude_config_id)
          if (Option.isSome(own)) return own.value
        } else if (task.session_id !== null) return null
        const project = task.project_id === null ? null : yield* repo.project(task.project_id)
        const [first] = yield* repo.configs(task.profile_id, project)
        if (first === undefined) return null
        return Option.getOrNull(yield* configs.get(first))
      })

      const ask = Effect.fnUntraced(function* (bottom: Task, config: AgentConfigRow | null, text: string) {
        const answer = yield* model.ask(config, stackTitle, text)
        if (answer.spent !== null) yield* sideCalls.record("title", bottom.id, config?.id ?? null, answer.spent)
        return Result.isSuccess(answer.reply) ? answer.reply.success : null
      })

      /** Write the title and description of the stack task `id` is in (see `schedule`). */
      const generate = Effect.fnUntraced(function* (id: TaskId, force: boolean) {
        const t = yield* repo.get(id)
        const bottom = t === null ? null : yield* settle(t)
        if (bottom === null || bottom.stack_pinned) return
        const rows = yield* rowsOf(bottom)
        const st = stackOf(rows, bottom)
        if (st === null || (!force && st.levels.every((x) => x.status === "done"))) return
        const text = stackInput(rows, st.levels)
        if (!force && (yield* inputOf(bottom.id)) === text) return
        const config = yield* configOf(bottom)
        // As title refreshes do: asked again, it answers.
        let reply = yield* ask(bottom, config, text)
        let got = reply === null ? null : parseStackReply(reply)
        if (got === null) {
          reply = yield* ask(bottom, config, text)
          got = reply === null ? null : parseStackReply(reply)
        }
        if (got === null) {
          yield* Effect.logWarning(`task ${bottom.id}: no stack title in the model's reply`)
          return
        }
        const parsed = got
        // Saved on the stack's bottom, if it's still that, and not pinned meanwhile; a change since has a write of its own
        // coming, from what it is by then.
        const now = yield* repo.get(bottom.id)
        const still = now === null ? null : stackOf(yield* rowsOf(now), now)
        if (now === null || still === null || still.bottom.id !== now.id) {
          if (still !== null) yield* schedule(still.bottom.id)
          return
        }
        let saved = false
        yield* tasks
          .change(
            now.id,
            (x) => {
              saved = !x.stack_pinned
              return saved ? { stack_title: parsed.title, stack_description: parsed.description } : null
            },
            board,
          )
          .pipe(Effect.ignore)
        if (saved) yield* inputs.setInput(now.id, text)
      })

      const update_ = (f: (b: Busy) => Busy) => SubscriptionRef.update(busy, f)

      /** Queue stack `id` to be written, one at a time; `force` even if unchanged or all done. */
      const enqueue = Effect.fnUntraced(function* (id: TaskId, force: boolean) {
        const fresh = yield* SubscriptionRef.modify(busy, (b): readonly [boolean, Busy] => {
          const was = b.queued.get(id)
          const queued = new Map(b.queued)
          queued.set(id, (was ?? false) || force)
          return [was === undefined, { ...b, queued }]
        })
        if (!fresh) return
        const work = Effect.gen(function* () {
          const f = yield* SubscriptionRef.modify(busy, (b): readonly [boolean, Busy] => {
            const queued = new Map(b.queued)
            const taken = queued.get(id) ?? force
            queued.delete(id)
            return [taken, { ...b, queued, writing: b.writing + 1 }]
          })
          yield* generate(id, f).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`task ${id}: writing its stack's title failed`, cause)),
            Effect.ensuring(update_((b) => ({ ...b, writing: b.writing - 1 }))),
          )
        })
        yield* FiberSet.run(writers, one.withPermits(1)(work))
      })

      /**
       * Write the stack whose bottom is `id` after the pause (from now, on the clock), unless it's changed again by then
       * (which starts the pause again).
       */
      const schedule = (id: TaskId, force = false): Effect.Effect<void> =>
        Effect.gen(function* () {
          const due = (yield* Clock.currentTimeMillis) + STACK_DEBOUNCE_MS
          yield* update_((b) => ({ ...b, timers: new Set([...b.timers, id]) }))
          const timer = Effect.gen(function* () {
            // Until `due`, however late this fiber starts.
            const left = due - (yield* Clock.currentTimeMillis)
            if (left > 0) yield* Effect.sleep(left)
            // Queued before it stops waiting, so `settled` never sees it as neither.
            yield* enqueue(id, force)
            yield* update_((b) => ({ ...b, timers: new Set([...b.timers].filter((x) => x !== id)) }))
          })
          yield* FiberMap.run(timers, id, timer)
        })

      // ---- what the reactor and the RPC call -----------------------------------------------------------------------

      const changed = Effect.fn("StackTitles.changed")(function* (change: TaskChanged) {
        const { before, after } = change
        if (after === null) {
          if (before === null || before.kind !== "task") return
          // Deleted: the stack below it and those of the levels on it, which may each be a stack's bottom now. Its
          // fields, if it held them, go to the first of those that has none, and so do the bottom's below it.
          const dropped = { fields: holds(before, null) ? fieldsOf(before, null) : null }
          const rows = yield* rowsOf(before)
          const belowId = stackedBelow(rows, before)?.id ?? null
          const below = belowId === null ? null : yield* repo.get(belowId)
          const under = below === null ? null : yield* settle(below, dropped)
          if (under !== null) yield* schedule(under.id)
          for (const level of stackedOn(rows, before.id).filter((x) => stackedBelow(rows, x)?.id === before.id)) {
            const bottom = yield* settle(level)
            if (bottom !== null) yield* schedule((yield* handOn(bottom, dropped)).id)
          }
          return
        }
        if (after.kind !== "task" || (before !== null && !watched(before, after))) return
        const dropped = { fields: null as Fields | null }
        // The stack it was in, if it was a level and isn't on that one now.
        const rows = yield* rowsOf(after)
        const wasId = before === null ? null : stackedBelow(rows, before)?.id
        if (wasId !== undefined && wasId !== null && wasId !== stackedBelow(rows, after)?.id) {
          const was = yield* repo.get(wasId)
          const bottom = was === null ? null : yield* settle(was, dropped)
          if (bottom !== null) yield* schedule(bottom.id)
        }
        const now = yield* repo.get(after.id)
        const bottom = now === null ? null : yield* settle(now)
        if (bottom !== null) yield* schedule((yield* handOn(bottom, dropped)).id)
      })

      const update = Effect.fn("StackTitles.update")(function* (id: TaskId, edit: StackEdit) {
        const t = yield* repo.get(id)
        if (t === null) return yield* new TaskNotFound({ id })
        const regenerate = edit.regenerate === true
        const edits = edit.title !== undefined || edit.description !== undefined
        if (regenerate && edits) return yield* new StackInvalid({ field: "regenerate", reason: "give a title or description, or regenerate, not both" })
        if (!regenerate && !edits) return yield* new StackInvalid({ field: "title", reason: "give a title, a description or regenerate: true" })
        if (edit.title !== undefined && chars(edit.title.trim()) > 200)
          return yield* new StackInvalid({ field: "title", reason: "title: at most 200 characters" })
        if (edit.description !== undefined && chars(edit.description.trim()) > 2000) {
          return yield* new StackInvalid({ field: "description", reason: "description: at most 2000 characters" })
        }
        const bottom = yield* settle(t)
        if (bottom === null)
          return yield* new StackInvalid({ field: "id", reason: "the task isn't in a stack: nothing lands after it, and it lands after nothing" })
        const updated = yield* tasks.change(
          bottom.id,
          () =>
            regenerate
              ? { stack_pinned: false }
              : {
                  stack_pinned: true,
                  ...(edit.title === undefined ? {} : { stack_title: blank(edit.title) }),
                  ...(edit.description === undefined ? {} : { stack_description: blank(edit.description) }),
                },
          Actor.user,
        )
        if (regenerate) {
          yield* inputs.setInput(bottom.id, null)
          yield* enqueue(bottom.id, true)
        }
        return updated
      })

      const resume = Effect.gen(function* () {
        const pass = Effect.gen(function* () {
          yield* Effect.sleep(STACK_RESUME)
          const bottoms = new Set<TaskId>()
          for (const id of yield* inputs.openLevels) {
            const t = yield* repo.get(id)
            const st = t === null ? null : stackOf(yield* rowsOf(t), t)
            if (st !== null && !bottoms.has(st.bottom.id)) {
              bottoms.add(st.bottom.id)
              yield* enqueue(st.bottom.id, false)
            }
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("writing stacks' titles", cause)))
        yield* FiberSet.run(writers, pass)
      }).pipe(Effect.withSpan("StackTitles.resume"))

      const settled = SubscriptionRef.changes(busy).pipe(
        Stream.filter((b) => b.timers.size === 0 && b.queued.size === 0 && b.writing === 0),
        Stream.take(1),
        Stream.runDrain,
      )

      return StackTitles.of({ changed, update, resume, settled })
    }),
  )
}
