import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Task } from "@huntaway/contracts"
import { gitRepo, TestBoard } from "@huntaway/testing"
import { Prompts } from "../agents/Prompts.ts"
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
})
