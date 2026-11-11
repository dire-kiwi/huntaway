import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Stream } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestBoard } from "@huntaway/testing"
import { ProfileId, ProjectId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { BoardEvent, NewTask, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRefs } from "./TaskRefs.ts"
import { TaskRepo } from "./TaskRepo.ts"
import { Tasks } from "./Tasks.ts"

// Tasks on the whole board's services (docs/plan/10-testing.md): an in-memory database, rows of profiles and projects
// put in with SQL. The rules themselves are decide.test.ts's.

const AT = "2026-11-12T00:00:00.000Z"

/** A profile `name` (its id too) and a project in it, keyed `key`, with id `<name>-<key>`. */
const seed = (name: string, key: string, more: { readonly archived?: boolean; readonly formerKeys?: ReadonlyArray<string> } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const profile = ProfileId.make(name)
    const project = ProjectId.make(`${name}-${key}`)
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (${profile}, ${name}, ${AT})`
    yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at, former_keys, archived_at, group_name)
      VALUES (${project}, ${profile}, ${`Project ${key}`}, ${key}, '/tmp/x', '/tmp/x/s', '/tmp/x/w', ${AT}, ${`[${(more.formerKeys ?? []).map((k) => `"${k}"`).join(",")}]`},
              ${more.archived === true ? AT : null}, 'Shop')`
    return { profile, project }
  }).pipe(Effect.orDie)

const create = (input: NewTask) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    return yield* tasks.create(input, Actor.user)
  })

const run = <A, E>(effect: Effect.Effect<A, E, Tasks | TaskRepo | TaskRefs | Events | Db | SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const describeEvent = (e: BoardEvent) => (e.type === "task" ? `task ${e.task.title}` : e.type === "task_deleted" ? `deleted ${e.id}` : e.type)
const ids = (list: ReadonlyArray<Task>) => list.map((t) => t.id).toSorted()

describe("Tasks", () => {
  it.effect("numbers a project's tasks, never reusing one, and keys them with its key", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const { project } = yield* seed("me", "WEB")
        const one = yield* create({ project_id: project, title: "One" })
        const two = yield* create({ project_id: project, title: "Two" })
        assert.deepStrictEqual([one.number, one.key, two.number, two.key, two.position], [1, "WEB-1", 2, "WEB-2", 2])
        yield* tasks.delete(two.id, { deleteBranch: false }, Actor.user)
        assert.strictEqual((yield* create({ project_id: project, title: "Three" })).key, "WEB-3")
      }),
    ),
  )

  it.effect("numbers tasks in no project by family, as before", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const { profile } = yield* seed("me", "WEB")
        const s1 = yield* create({ profile_id: profile })
        const s2 = yield* create({ profile_id: profile, title: "Notes" })
        const g1 = yield* create({ profile_id: profile, group: "Shop", title: "Plan" })
        assert.deepStrictEqual([s1.key, s1.title, s1.task_type, s2.key, g1.key, g1.group_name], ["S-1", "New scratch task", "scratch", "S-2", "G-1", "Shop"])
        // Not a counter: deleting the highest lets its number be used again.
        yield* tasks.delete(s2.id, { deleteBranch: false }, Actor.user)
        assert.strictEqual((yield* create({ profile_id: profile })).key, "S-2")
      }),
    ),
  )

  it.effect("doesn't use up a number on a task that can't be added (HA-37)", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TaskRepo
        const db = yield* Db
        const { profile, project } = yield* seed("me", "WEB")
        const row = (profile_id: ProfileId) => ({
          family: "project" as const,
          profile_id,
          project_id: project,
          columns: { title: "x", status: "todo" as const },
          generateTitle: false,
        })
        const now = Timestamp.make(AT)
        const failed = yield* db.tx(repo.insert(TaskId.make("a"), row(ProfileId.make("nobody")), now)).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(failed))
        yield* db.tx(repo.insert(TaskId.make("b"), row(profile), now))
        assert.strictEqual((yield* repo.get("b"))?.number, 1)
      }),
    ),
  )

  it.effect("refuses a task in a project that isn't there or is archived", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const { project } = yield* seed("me", "OLD", { archived: true })
        const missing = yield* create({ project_id: ProjectId.make("nope"), title: "x" }).pipe(Effect.flip)
        assert.strictEqual(missing._tag, "ProjectNotFound")
        const archived = yield* create({ project_id: project, title: "x" }).pipe(Effect.flip)
        assert.deepStrictEqual([archived._tag, archived._tag === "Conflict" ? archived.reason : null], ["Conflict", "archived"])
        const noProfile = yield* create({ profile_id: ProfileId.make("nobody") }).pipe(Effect.flip)
        assert.strictEqual(noProfile._tag, "ProfileNotFound")
        assert.strictEqual((yield* tasks.list({ _tag: "ByProject", project_id: ProjectId.make("nope") }).pipe(Effect.flip))._tag, "ProjectNotFound")
      }),
    ),
  )

  it.effect("emits one task event after an update commits, and none for one refused", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const events = yield* Events
        const { project } = yield* seed("me", "WEB")
        const t = yield* create({ project_id: project, title: "Fix it" })
        const watch = yield* events.watch(undefined)
        const seen = yield* watch.live.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        const refused = yield* tasks.update(t.id, { title: " " }, Actor.user).pipe(Effect.flip)
        assert.strictEqual(refused._tag, "Invalid")
        assert.strictEqual(yield* events.seq, watch.seq, "nothing published for a refused update")
        const updated = yield* tasks.update(t.id, { title: "Fixed" }, Actor.user)
        assert.deepStrictEqual([updated.title, updated.title_pinned], ["Fixed", true])
        const [event] = yield* Fiber.join(seen)
        assert.deepStrictEqual(event?.type === "task" ? [event.task.id, event.task.title] : event, [t.id, "Fixed"])
        assert.strictEqual(yield* events.seq, watch.seq + 1)
        // An update that changes nothing writes nothing and tells nobody.
        assert.strictEqual((yield* tasks.update(t.id, {}, Actor.user)).updated_at, updated.updated_at)
        assert.strictEqual(yield* events.seq, watch.seq + 1)
      }),
    ),
  )

  it.effect("serialises changes to one task: no write is lost", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const { project } = yield* seed("me", "WEB")
        const t = yield* create({ project_id: project, title: "Count" })
        // Each reads the position and writes it plus one: interleaved, one of them would be lost.
        const bump = tasks.change(t.id, (now) => ({ position: now.position + 1 }), Actor.board)
        const fibers = yield* Effect.forEach([bump, bump, bump], (e) => Effect.forkChild(e), { concurrency: 1 })
        yield* Fiber.joinAll(fibers)
        assert.strictEqual((yield* tasks.get(t.id)).position, t.position + 3)
        // Two updates at once each land, in one order or the other.
        const a = yield* Effect.forkChild(tasks.update(t.id, { title: "A", description: "from A" }, Actor.user))
        const b = yield* Effect.forkChild(tasks.update(t.id, { title: "B", model: "haiku" }, Actor.user))
        yield* Fiber.joinAll([a, b])
        const both = yield* tasks.get(t.id)
        assert.include(["A", "B"], both.title)
        assert.deepStrictEqual([both.description, both.model], ["from A", "haiku"])
      }),
    ),
  )

  it.effect("deletes a task and puts right what pointed at it", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const events = yield* Events
        const sql = yield* SqlClient.SqlClient
        const { project } = yield* seed("me", "WEB")
        const target = yield* create({ project_id: project, title: "Target", use_worktree: true })
        const into = yield* create({ project_id: project, title: "Into", use_worktree: true, merges_into: target.key })
        const dependant = yield* create({ project_id: project, title: "After", depends_on: [target.id] })
        yield* tasks.update(into.id, { status: "in_review" }, Actor.board)
        yield* sql`INSERT INTO tasks (id, profile_id, project_id, kind, parent_id, title, last_activity_at, created_at, updated_at)
          VALUES ('review', 'me', ${project}, 'review', ${target.id}, 'Review', ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
        yield* sql`INSERT INTO task_queue (task_id, text, source, created_at) VALUES (${target.id}, 'next', 'user', ${AT})`.pipe(Effect.orDie)
        const watch = yield* events.watch(undefined)
        const seen = yield* watch.live.pipe(Stream.take(4), Stream.runCollect, Effect.forkChild)
        yield* tasks.delete(target.id, { deleteBranch: false }, Actor.user)

        assert.strictEqual((yield* tasks.get(target.id).pipe(Effect.flip))._tag, "TaskNotFound")
        assert.deepStrictEqual((yield* tasks.get(dependant.id)).depends_on, [])
        const held = yield* tasks.get(into.id)
        // Its link stays, to the task that's gone, until the user chooses.
        assert.deepStrictEqual(
          [held.merges_into, held.status, held.attention_reason],
          [target.id, "needs_attention", "WEB-1, which this task merges into, was deleted: choose where it merges now"],
        )
        const left = yield* sql<{
          readonly n: number
        }>`SELECT (SELECT COUNT(*) FROM task_queue) + (SELECT COUNT(*) FROM tasks WHERE id IN ('review', ${target.id})) AS n`.pipe(Effect.orDie)
        assert.strictEqual(left[0]?.n, 0)
        assert.deepStrictEqual(
          (yield* Fiber.join(seen)).map(describeEvent).toSorted(),
          ["deleted review", `deleted ${target.id}`, "task After", "task Into"].toSorted(),
        )
        // The review thread goes before its task.
        const order = (yield* Fiber.join(seen)).map(describeEvent).filter((d) => d.startsWith("deleted"))
        assert.deepStrictEqual(order, ["deleted review", `deleted ${target.id}`])
      }),
    ),
  )

  it.effect("never deletes the profile's assistant", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const sql = yield* SqlClient.SqlClient
        yield* seed("me", "WEB")
        yield* sql`INSERT INTO tasks (id, profile_id, task_type, number, title, last_activity_at, created_at, updated_at)
          VALUES ('assistant', 'me', 'assistant', 1, 'Assistant', ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
        const refused = yield* tasks.delete(TaskId.make("assistant"), { deleteBranch: false }, Actor.user).pipe(Effect.flip)
        assert.deepStrictEqual([refused._tag, refused._tag === "Conflict" ? refused.reason : null], ["Conflict", "in_use"])
      }),
    ),
  )

  it.effect("lists a board's tasks without the threads that aren't on it", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const sql = yield* SqlClient.SqlClient
        const { profile, project } = yield* seed("me", "WEB")
        const code = yield* create({ project_id: project, title: "Code" })
        const scratch = yield* create({ profile_id: profile, title: "Scratch" })
        const insert = (tid: string, type: string, kind = "task", parent: string | null = null) =>
          sql`INSERT INTO tasks (id, profile_id, project_id, kind, parent_id, task_type, title, last_activity_at, created_at, updated_at)
            VALUES (${tid}, 'me', ${kind === "review" ? project : null}, ${kind}, ${parent}, ${type === "" ? null : type}, ${tid}, ${AT}, ${AT}, ${AT})`.pipe(
            Effect.orDie,
          )
        yield* insert("assistant", "assistant")
        yield* insert("routine", "routine", "task", "assistant")
        yield* insert("pens", "pens")
        yield* insert("pen", "pen")
        yield* insert("review", "", "review", code.id)
        assert.deepStrictEqual(ids(yield* tasks.list({ _tag: "ByProject", project_id: project })), [code.id])
        assert.deepStrictEqual(ids(yield* tasks.list({ _tag: "ByProject", project_id: project, kind: "review" })), ["review"])
        assert.deepStrictEqual(ids(yield* tasks.list({ _tag: "ByProfile", profile_id: profile })), [code.id, scratch.id].toSorted())
        assert.deepStrictEqual(
          ids(yield* tasks.list({ _tag: "ByProfile", profile_id: profile, include_assistant: true })),
          ["assistant", code.id, scratch.id].toSorted(),
        )
        assert.deepStrictEqual(ids(yield* tasks.list({ _tag: "Projectless", profile_id: profile })), [scratch.id])
        assert.deepStrictEqual(
          ids(yield* tasks.list({ _tag: "Projectless", profile_id: profile, include_assistant: true, include_pens: true, include_pen_threads: true })),
          ["assistant", "pen", "pens", scratch.id].toSorted(),
        )
        // The board's snapshot: everything the old client loaded but routine threads, and archived projects' tasks too.
        const archived = yield* seed("me", "OLD", { archived: true })
        yield* sql`INSERT INTO tasks (id, profile_id, project_id, title, last_activity_at, created_at, updated_at)
          VALUES ('shelved', 'me', ${archived.project}, 'Shelved', ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
        assert.deepStrictEqual(ids(yield* (yield* TaskRepo).all), ["assistant", code.id, "pen", "pens", "review", scratch.id, "shelved"].toSorted())
      }),
    ),
  )

  it.effect("reads the queue and steers off their rows, and a bad stored value as empty", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const sql = yield* SqlClient.SqlClient
        const { project } = yield* seed("me", "WEB")
        const t = yield* create({ project_id: project, title: "Busy" })
        yield* sql`INSERT INTO task_queue (task_id, text, source, created_at) VALUES (${t.id}, 'first', 'user', ${AT}), (${t.id}, '', 'automation', ${AT}),
          (${t.id}, 'second', 'agent', ${AT})`.pipe(Effect.orDie)
        yield* sql`INSERT INTO task_steers (id, seq, task_id, run_id, text, source, automation_run_id, written, created_at)
          VALUES ('s1', 1, ${t.id}, 'r', 'look', 'agent', NULL, 1, ${AT}), ('s2', 2, ${t.id}, 'r', 'daily', 'routine', 'ar', 0, ${AT})`.pipe(Effect.orDie)
        yield* sql`UPDATE tasks SET todos = 'not json', review = '{"thread_id": 3}' WHERE id = ${t.id}`.pipe(Effect.orDie)
        const read = yield* tasks.get(t.id)
        assert.strictEqual(read.queued_message, "first\n\nsecond")
        assert.deepStrictEqual(read.steering, [
          { id: "s1", text: "look", from_agent: true, run_id: RunId.make("r"), written: true },
          { id: "s2", text: "daily", from_agent: false, run_id: RunId.make("r"), written: false, routine_runs: ["ar"], routine: true },
        ])
        assert.deepStrictEqual([read.todos, read.review], [[], null])
      }),
    ),
  )
})

describe("TaskRefs", () => {
  it.effect("finds a task by id, key in any case, a former key, or <profile>:<key>", () =>
    run(
      Effect.gen(function* () {
        const refs = yield* TaskRefs
        const mine = yield* seed("me", "WEB", { formerKeys: ["SHOP"] })
        const theirs = yield* seed("work", "SD")
        const other = yield* seed("other", "WEB")
        const t = yield* create({ project_id: mine.project, title: "Mine" })
        const sd = yield* create({ project_id: theirs.project, title: "Theirs" })
        const s = yield* create({ profile_id: mine.profile, title: "Notes" })
        const id = (ref: string, within?: Parameters<typeof refs.resolve>[1]) => Effect.map(refs.resolve(ref, within), (x) => x.id)
        assert.strictEqual(yield* id(t.id), t.id)
        assert.strictEqual(yield* id("sd-1"), sd.id)
        assert.strictEqual(yield* id("work:SD-1"), sd.id)
        assert.strictEqual(yield* id("me:shop-1"), t.id)
        assert.strictEqual(yield* id("me:S-1"), s.id)
        // WEB-1 is on two boards: the caller's own, or name the board.
        yield* create({ project_id: other.project, title: "Other" })
        assert.strictEqual((yield* refs.resolve("WEB-1").pipe(Effect.flip))._tag, "TaskRefAmbiguous")
        assert.strictEqual(yield* id("WEB-1", { own: mine.profile }), t.id)
        assert.strictEqual(yield* id("me:WEB-1"), t.id)
        for (const missing of ["WEB-9", "nope", "work:WEB-1", "X-"]) {
          assert.strictEqual((yield* refs.resolve(missing).pipe(Effect.flip))._tag, "TaskNotFound", missing)
        }
      }),
    ),
  )
})
