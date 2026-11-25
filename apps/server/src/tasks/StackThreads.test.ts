import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import type { Task } from "@huntaway/contracts"
import { gitRepo, TestBoard } from "@huntaway/testing"
import { Prompts } from "../agents/Prompts.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { StackThreads } from "./StackThreads.ts"
import { TaskRepo } from "./TaskRepo.ts"
import { Tasks } from "./Tasks.ts"

// A stack's own thread (HE-105) on the whole board's services: made once, under the stack's bottom, kept with the stack
// when its bottom is deleted, and what it and the stack's levels are told.

const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)

/** A project with a stack of three levels (WEB-1, then WEB-2 on it, then WEB-3 on that) and a task in no stack (WEB-4). */
const board = Effect.gen(function* () {
  const me = yield* (yield* Profiles).create({ name: "me" })
  const project = yield* (yield* Projects).create({ profile_id: me.id, name: "Web", key: "WEB", repo_path: yield* gitRepo })
  const tasks = yield* Tasks
  const mk = (title: string, below: Task | null) =>
    Effect.gen(function* () {
      const made = yield* tasks.create({ project_id: project.id, title }, Actor.user)
      return below === null ? made : yield* tasks.change(made.id, () => ({ start_from: { type: "task", task_id: below.id } }), Actor.user)
    })
  const a = yield* mk("Sign-in", null)
  const b = yield* mk("Admin portal", a)
  const c = yield* mk("Word import", b)
  const lone = yield* mk("Unrelated", null)
  return { project, a, b, c, lone }
}).pipe(Effect.orDie)

/** What the reactor has to do with the changes so far, done. */
const settled = Effect.flatMap(Reactor, (r) => r.idle)
const parentOf = (id: Task["id"]) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (r) => r.get(id)),
    (t) => (t === null ? "gone" : t.parent_id),
  )
const deleteTask = (id: Task["id"]) => Effect.flatMap(TaskDeletion, (d) => d.delete(id, { deleteBranch: false }, Actor.user)).pipe(Effect.orDie)
const startFrom = (t: Task, below: Task | null) =>
  Effect.flatMap(Tasks, (tasks) => tasks.change(t.id, () => ({ start_from: below === null ? null : { type: "task", task_id: below.id } }), Actor.user)).pipe(
    Effect.orDie,
  )

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

describe("StackThreads", () => {
  it.effect("makes a stack's thread once, in its project under its bottom, from any level", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const { project, a, b, c, lone } = yield* board
        const made = yield* threads.thread(c.id)
        assert.deepStrictEqual(
          [made.key, made.title, made.task_type, made.parent_id, made.project_id, made.status, made.use_worktree],
          ["WEB-5", "Stack: Sign-in", "stack", a.id, project.id, "todo", false],
        )
        // Any level, or the thread itself, gives the same thread.
        assert.strictEqual((yield* threads.thread(b.id)).id, made.id)
        assert.strictEqual((yield* threads.thread(made.id)).id, made.id)
        assert.strictEqual((yield* threads.find(a))?.id, made.id)
        // A task in no stack has none.
        assert.strictEqual(yield* tag(threads.thread(lone.id)), "Invalid")
        assert.isNull(yield* threads.find(lone))
        // It never goes to review, merge or Done.
        assert.strictEqual(yield* tag((yield* Tasks).update(made.id, { status: "in_review" }, Actor.user)), "Invalid")
      }),
    ),
  )

  it.effect("tells a level to refer stack management to the thread, making it, and the thread of its stack", () =>
    run(
      Effect.gen(function* () {
        const prompts = yield* Prompts
        const { a, b, c, lone } = yield* board
        const level = yield* prompts.system(b.id, { codex: false, permission_mode: "default" })
        const thread = yield* (yield* StackThreads).thread(a.id)
        assert.isTrue(level.includes(`This task is level 2 of 3 of a stack ("Sign-in"), whose own thread, ${thread.key}, manages the stack`), level)
        assert.isFalse((yield* prompts.system(lone.id, { codex: false, permission_mode: "default" })).includes("manages the stack"))
        const told = yield* prompts.system(thread.id, { codex: false, permission_mode: "default" })
        assert.isTrue(told.startsWith(`You look after one stack of tasks on the Huntaway board`), told)
        assert.isTrue(told.includes('Your stack, as it was when this run started: "Sign-in"'), told)
        assert.isTrue(
          told.includes(`1. WEB-1 [todo] Sign-in (id ${a.id})`) && told.includes(`2. WEB-2 [todo] Admin portal (id ${b.id}), lands after WEB-1`),
          told,
        )
        assert.isTrue(told.includes(`3. WEB-3 [todo] Word import (id ${c.id}), lands after WEB-2`), told)
        // Its first prompt is the message, as a conversation's.
        assert.strictEqual(yield* prompts.start(thread.id, "Restack it, please."), "Restack it, please.")
      }),
    ),
  )

  it.effect("stays with the stack when its bottom is deleted, and goes with the last of it", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const tasks = yield* Tasks
        const repo = yield* TaskRepo
        const { a, b, c } = yield* board
        const made = yield* threads.thread(b.id)
        yield* tasks.delete(a.id, { deleteBranch: false }, Actor.user)
        assert.strictEqual((yield* repo.get(made.id))?.parent_id, b.id)
        assert.strictEqual((yield* threads.thread(c.id)).id, made.id)
        // With nothing landing after it, the thread goes with it.
        yield* tasks.delete(c.id, { deleteBranch: false }, Actor.user)
        yield* tasks.delete(b.id, { deleteBranch: false }, Actor.user)
        assert.isNull(yield* repo.get(made.id))
      }),
    ),
  )

  it.effect("keeps the thread with the stack when its merged bottom is deleted, which unstacks the levels first", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const { a, b, c } = yield* board
        const made = yield* threads.thread(c.id)
        yield* (yield* Tasks).change(a.id, () => ({ status: "done", resolution: "done" }), Actor.user).pipe(Effect.orDie)
        yield* settled
        yield* deleteTask(a.id)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), b.id)
        assert.strictEqual((yield* threads.thread(c.id)).id, made.id)
        // Two levels merged and deleted from the bottom: the last one left is no stack, and its thread goes.
        yield* (yield* Tasks).change(b.id, () => ({ status: "done", resolution: "done" }), Actor.user).pipe(Effect.orDie)
        yield* settled
        yield* deleteTask(b.id)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), "gone")
      }),
    ),
  )

  it.effect("follows the stack's bottom, and the part a split takes, and goes once there's no stack", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const { a, b, c, lone } = yield* board
        const made = yield* threads.thread(b.id)
        // A level put below the bottom is the bottom now.
        yield* startFrom(a, lone)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), lone.id)
        // Split off below the bottom: it stays with the rest of the stack.
        yield* startFrom(a, null)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), a.id)
        // Split in the middle, leaving the bottom alone: it goes with the part that's still a stack.
        yield* startFrom(b, null)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), b.id)
        assert.strictEqual((yield* threads.thread(c.id)).id, made.id)
        assert.strictEqual(yield* tag(threads.thread(a.id)), "Invalid")
        // The two-level stack's bottom deleted (not merged): what's left waits for the user under the level held on it.
        yield* deleteTask(b.id)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), c.id)
        // Closed too, as the user may choose: no stack is left, and its thread goes.
        yield* (yield* Tasks).change(c.id, () => ({ status: "done", resolution: "not_done" }), Actor.user).pipe(Effect.orDie)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), "gone")
      }),
    ),
  )

  it.effect("stays with the stack when a middle level is deleted, held for the user, and once it's restacked", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const { a, b, c } = yield* board
        const made = yield* threads.thread(c.id)
        yield* deleteTask(b.id)
        yield* settled
        // The level on the deleted one waits for the user, and the thread waits with it.
        const held = yield* Effect.flatMap(TaskRepo, (r) => r.get(c.id))
        assert.strictEqual(held?.status, "needs_attention")
        assert.strictEqual(yield* parentOf(made.id), c.id)
        const told = yield* (yield* Prompts).system(made.id, { codex: false, permission_mode: "default" })
        assert.isTrue(told.includes(`the level below WEB-3 ("Word import", id ${c.id}) was deleted`), told)
        // Restacked onto the bottom: one stack again, with the same thread under its bottom.
        yield* startFrom(c, a)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), a.id)
        assert.strictEqual((yield* threads.thread(c.id)).id, made.id)
      }),
    ),
  )

  it.effect("follows the levels on a deleted middle level that's still a stack, flagged or not", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const tasks = yield* Tasks
        const { a, b, c } = yield* board
        const d = yield* startFrom(
          yield* tasks.create({ project_id: a.project_id ?? assert.fail("no project"), title: "Export" }, Actor.user).pipe(Effect.orDie),
          c,
        )
        const made = yield* threads.thread(d.id)
        // Its agent running, the level on the deleted one isn't flagged, so the deletion is the only change.
        yield* tasks.change(c.id, () => ({ running: true }), Actor.user).pipe(Effect.orDie)
        yield* settled
        yield* deleteTask(b.id)
        yield* settled
        assert.notStrictEqual((yield* Effect.flatMap(TaskRepo, (r) => r.get(c.id)))?.status, "needs_attention")
        assert.strictEqual(yield* parentOf(made.id), c.id)
        assert.strictEqual((yield* threads.thread(d.id)).id, made.id)
      }),
    ),
  )

  it.effect("isn't something a task can wait for, start from or merge into", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const { b, lone } = yield* board
        const made = yield* (yield* StackThreads).thread(b.id)
        assert.strictEqual(yield* tag(tasks.update(lone.id, { depends_on: [made.id] }, Actor.user)), "Invalid")
        assert.strictEqual(yield* tag(tasks.update(lone.id, { merges_into: made.id }, Actor.user)), "Invalid")
        assert.strictEqual(yield* tag(tasks.update(lone.id, { start_from: { type: "task", task_id: made.id } }, Actor.user)), "Invalid")
      }),
    ),
  )

  it.effect("keeps the stack's thread when a merged level above the bottom is deleted", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const tasks = yield* Tasks
        const { a, b, c } = yield* board
        const d = yield* startFrom(
          yield* tasks.create({ project_id: a.project_id ?? assert.fail("no project"), title: "Export" }, Actor.user).pipe(Effect.orDie),
          c,
        )
        const made = yield* threads.thread(d.id)
        for (const t of [a, b]) yield* tasks.change(t.id, () => ({ status: "done", resolution: "done" }), Actor.user).pipe(Effect.orDie)
        yield* settled
        yield* deleteTask(b.id)
        yield* settled
        assert.strictEqual(yield* parentOf(made.id), c.id)
        assert.strictEqual((yield* threads.thread(d.id)).id, made.id)
      }),
    ),
  )

  it.effect("keeps the older thread when two stacks are joined, whichever side it's on", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* StackThreads
        const tasks = yield* Tasks
        const { project, a, b, c } = yield* board
        // Another stack, x then y, whose thread is made first.
        const x = yield* tasks.create({ project_id: project.id, title: "Other" }, Actor.user).pipe(Effect.orDie)
        const y = yield* startFrom(yield* tasks.create({ project_id: project.id, title: "Other on it" }, Actor.user).pipe(Effect.orDie), x)
        const older = yield* threads.thread(y.id)
        yield* TestClock.adjust("1 second")
        const newer = yield* threads.thread(c.id)
        yield* settled
        // x's stack (with the older thread) put on c, the top of the other.
        yield* startFrom(x, c)
        yield* settled
        assert.strictEqual(yield* parentOf(newer.id), "gone")
        assert.strictEqual(yield* parentOf(older.id), a.id)
        assert.strictEqual((yield* threads.thread(b.id)).id, older.id)
      }),
    ),
  )
})
