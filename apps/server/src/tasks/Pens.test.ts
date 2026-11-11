import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import type { FileSystem } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId, TaskId } from "@huntaway/contracts"
import type { BoardEvent, Pen, Task } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { Board } from "../lifecycle/Board.ts"
import { Actor } from "../platform/Changes.ts"
import { Events } from "../platform/Events.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { PEN_COLORS } from "./penChecks.ts"
import { Pens } from "./Pens.ts"
import { Tasks } from "./Tasks.ts"

// Pens (huntaway's mcp/tools/pens.test.ts, the API's and the services' cases) on the whole board's services.

const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)
const names = (pens: ReadonlyArray<Pen>) => pens.map((p) => [p.name, p.task_count])

/** A profile with two projects and a task in each, and a scratch task (the old test's `board`). */
const board = Effect.gen(function* () {
  const profiles = yield* Profiles
  const projects = yield* Projects
  const tasks = yield* Tasks
  const dir = yield* tempDir
  const profile = yield* profiles.create({ name: "personal" })
  const web = yield* projects.create({ profile_id: profile.id, name: "web", key: "WEB", repo_path: `${dir}/web` })
  const api = yield* projects.create({ profile_id: profile.id, name: "api", key: "API", repo_path: `${dir}/api` })
  const webTask = yield* tasks.create({ project_id: web.id, title: "Web thing" }, Actor.user)
  const apiTask = yield* tasks.create({ project_id: api.id, title: "API thing" }, Actor.user)
  const scratch = yield* tasks.create({ profile_id: profile.id, title: "Notes" }, Actor.user)
  return { profile: profile.id, webTask, apiTask, scratch }
})

/** A thread of the profile's in no project, as later milestones make them (the pens thread, a pen's thread). */
const insertThread = (profile: ProfileId, id: string, type: "pens" | "pen", number: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`INSERT INTO tasks ${sql.insert({ id, profile_id: profile, task_type: type, title: type, number, last_activity_at: "", created_at: "", updated_at: "" })}`,
  ).pipe(Effect.orDie)

const run = <A, E>(
  effect: Effect.Effect<A, E, Pens | Tasks | Profiles | Projects | Events | Board | SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const pen = (task: Task) => task.pen_id

describe("Pens", () => {
  it.effect("arranges tasks from every project and none into pens, by name in any case, made when missing", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const tasks = yield* Tasks
        const { profile, webTask, apiTask, scratch } = yield* board
        const today = yield* pens.create({ profile_id: profile, name: "  Today  " })
        assert.deepStrictEqual([today.name, today.position, today.active, today.color, today.task_count, today.thread_id], ["Today", 1, true, "blue", 0, null])
        // A pen by its name, in any case; one that isn't there yet is made.
        assert.strictEqual(pen(yield* tasks.update(webTask.id, { pen: "today" }, Actor.user)), today.id)
        assert.strictEqual(pen(yield* tasks.update(apiTask.id, { pen: "Today" }, Actor.user)), today.id)
        const parked = pen(yield* tasks.update(scratch.id, { pen: "Parked" }, Actor.user))
        assert.deepStrictEqual(names(yield* pens.list(profile)), [
          ["Today", 2],
          ["Parked", 1],
        ])
        // Made inactive, renamed and moved to the front.
        assert.isNotNull(parked)
        if (parked === null) return
        const later = yield* pens.update(parked, { active: false, name: "Later on", index: 0 })
        assert.deepStrictEqual([later.active, later.name], [false, "Later on"])
        assert.deepStrictEqual(
          (yield* pens.list(profile)).map((p) => [p.name, p.position, p.active]),
          [
            ["Later on", 1, false],
            ["Today", 2, true],
          ],
        )
        // Active again, leaving the rest as it was; and a pen can start inactive.
        assert.deepStrictEqual([(yield* pens.update(parked, { active: true })).active, (yield* pens.list(profile))[0]?.name], [true, "Later on"])
        assert.isFalse((yield* pens.create({ profile_id: profile, name: "Someday", active: false })).active)
        // A name is the profile's once, in any case; and never blank or too long.
        assert.strictEqual(yield* tag(pens.update(today.id, { name: "later ON" })), "Conflict")
        assert.strictEqual(yield* tag(pens.create({ profile_id: profile, name: "TODAY" })), "Conflict")
        assert.strictEqual(yield* tag(pens.create({ profile_id: profile, name: "  " })), "Invalid")
        assert.strictEqual(yield* tag(pens.create({ profile_id: profile, name: "x".repeat(61) })), "Invalid")
        assert.strictEqual(yield* tag(tasks.update(webTask.id, { pen: "x".repeat(61) }, Actor.user)), "Invalid")
        // Out of a pen ("" or null), and a pen deleted: its tasks stay, in no pen.
        assert.isNull(pen(yield* tasks.update(apiTask.id, { pen: "" }, Actor.user)))
        assert.deepStrictEqual(yield* pens.delete(today.id, Actor.user), [webTask.id])
        assert.isNull(pen(yield* tasks.get(webTask.id)))
        assert.deepStrictEqual(names(yield* pens.list(profile)), [
          ["Later on", 1],
          ["Someday", 0],
        ])
        assert.isNull(pen(yield* tasks.update(scratch.id, { pen_id: null }, Actor.user)))
        assert.strictEqual(yield* tag(pens.delete(today.id, Actor.user)), "PenNotFound")
        assert.strictEqual(yield* tag(pens.update(today.id, { active: true })), "PenNotFound")
      }),
    ),
  )

  it.effect("keeps another profile's pens out of reach", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const tasks = yield* Tasks
        const { webTask } = yield* board
        const other = yield* (yield* Profiles).create({ name: "work" })
        const theirs = yield* pens.create({ profile_id: other.id, name: "Secret" })
        // Not by id, and by name it's another pen, the task's profile's own.
        const refused = yield* Effect.flip(tasks.update(webTask.id, { pen_id: theirs.id }, Actor.user))
        assert.deepStrictEqual(refused._tag === "NotFound" ? [refused.what, refused.id] : refused._tag, ["pen", theirs.id])
        const mine = pen(yield* tasks.update(webTask.id, { pen: "Secret" }, Actor.user))
        assert.notStrictEqual(mine, theirs.id)
        assert.deepStrictEqual(names(yield* pens.list(other.id)), [["Secret", 0]])
        assert.strictEqual(yield* tag(pens.list(ProfileId.make("nobody"))), "ProfileNotFound")
      }),
    ),
  )

  it.effect("tells the boards: `pens` with the profile's pens, and a task event for each task a deleted pen leaves", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const tasks = yield* Tasks
        const events = yield* Events
        const { profile, webTask } = yield* board
        const watch = yield* events.watch(undefined)
        const seen = yield* watch.live.pipe(Stream.take(6), Stream.runCollect, Effect.forkChild)
        const today = yield* pens.create({ profile_id: profile, name: "Today" })
        // A move into a pen by name makes it: `pens`, then the task.
        yield* tasks.update(webTask.id, { pen: "Parked" }, Actor.user)
        yield* tasks.update(webTask.id, { pen_id: today.id }, Actor.user)
        yield* pens.delete(today.id, Actor.user)
        const got = yield* Fiber.join(seen)
        const said = (e: BoardEvent) =>
          e.type === "pens"
            ? `pens ${e.profile_id === profile ? e.pens.map((p) => p.name).join(",") : "?"}`
            : e.type === "task"
              ? `task ${e.task.pen_id === null ? "out" : "in"}`
              : e.type
        assert.deepStrictEqual(got.map(said), ["pens Today", "pens Today,Parked", "task in", "task in", "task out", "pens Parked"])
        // A refused move makes no pen and says nothing.
        const before = yield* events.seq
        assert.strictEqual(yield* tag(tasks.update(webTask.id, { pen: "Never", title: " " }, Actor.user)), "Invalid")
        assert.strictEqual(yield* events.seq, before)
        assert.deepStrictEqual(names(yield* pens.list(profile)), [["Parked", 0]])
      }),
    ),
  )

  it.effect("gives each new pen a colour the profile's other pens don't have, else one the fewest have", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const { profile } = yield* board
        const made: Array<Pen> = []
        for (let i = 0; i < PEN_COLORS.length; i++) made.push(yield* pens.create({ profile_id: profile, name: `Pen ${i}` }))
        assert.deepStrictEqual(
          made.map((p) => p.color),
          [...PEN_COLORS],
        )
        // Another profile starts again from the first.
        const other = yield* (yield* Profiles).create({ name: "work" })
        assert.strictEqual((yield* pens.create({ profile_id: other.id, name: "Theirs" })).color, "blue")
        // A colour that's free again goes to the next pen.
        const fourth = made[3]
        const first = made[0]
        if (fourth === undefined || first === undefined) return
        yield* pens.delete(fourth.id, Actor.user)
        assert.strictEqual((yield* pens.create({ profile_id: profile, name: "Fourth again" })).color, fourth.color)
        // Blue is free once its pen goes green; then all are taken (green twice), so the first of the rest.
        assert.strictEqual((yield* pens.update(first.id, { color: "green" })).color, "green")
        assert.strictEqual((yield* pens.create({ profile_id: profile, name: "Blue again" })).color, "blue")
        assert.strictEqual((yield* pens.create({ profile_id: profile, name: "Blue twice" })).color, "blue")
        assert.strictEqual((yield* pens.create({ profile_id: profile, name: "Orange twice" })).color, "orange")
        // Or the one asked for.
        assert.strictEqual((yield* pens.create({ profile_id: profile, name: "Today", color: "teal" })).color, "teal")
      }),
    ),
  )

  it.effect("keeps the pens' own threads out of pens, renames a pen's thread with it, and deletes it with its pen", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const tasks = yield* Tasks
        const sql = yield* SqlClient.SqlClient
        const { profile, webTask } = yield* board
        yield* insertThread(profile, "pens-thread", "pens", 2)
        yield* insertThread(profile, "pen-thread", "pen", 3)
        const thread = TaskId.make("pen-thread")
        // The pens thread and a pen's thread last off the board: neither goes into a pen (both may be taken out).
        assert.strictEqual(yield* tag(tasks.update(TaskId.make("pens-thread"), { pen: "Today" }, Actor.user)), "Invalid")
        assert.strictEqual(yield* tag(tasks.update(thread, { pen: "Today" }, Actor.user)), "Invalid")
        assert.isNull(pen(yield* tasks.update(thread, { pen: null }, Actor.user)))
        // A pen whose thread has been opened.
        const today = yield* pens.create({ profile_id: profile, name: "Today" })
        yield* sql`UPDATE pens SET thread_id = ${thread} WHERE id = ${today.id}`
        yield* tasks.update(webTask.id, { pen_id: today.id }, Actor.user)
        assert.strictEqual((yield* pens.update(today.id, { name: "This week" })).thread_id, thread)
        assert.strictEqual((yield* tasks.get(thread)).title, "Pen: This week")
        // Not by its own thread's hand.
        assert.strictEqual(yield* tag(pens.delete(today.id, { _tag: "Agent", task_id: thread })), "Conflict")
        yield* pens.delete(today.id, Actor.user)
        assert.strictEqual(yield* tag(tasks.get(thread)), "TaskNotFound")
        // Its tasks stay.
        assert.isNull(pen(yield* tasks.get(webTask.id)))
      }),
    ),
  )

  it.effect("are in the board's snapshot", () =>
    run(
      Effect.gen(function* () {
        const pens = yield* Pens
        const { profile } = yield* board
        yield* pens.create({ profile_id: profile, name: "Today" })
        const other = yield* (yield* Profiles).create({ name: "work" })
        yield* pens.create({ profile_id: other.id, name: "Theirs" })
        const snapshot = yield* (yield* Board).snapshot(0)
        assert.deepStrictEqual(snapshot.pens.map((p) => p.name).toSorted(), ["Theirs", "Today"])
      }),
    ),
  )
})
