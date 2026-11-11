import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestPlatform } from "@huntaway/testing"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Status } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Leftovers } from "./Leftovers.ts"
import { fnv1a, folder, REMOVING, rootIn, TaskTmp } from "./TaskTmp.ts"
import type { TaskTmpOptions } from "./TaskTmp.ts"

// The old task_tmp.test.ts's cases. The task's own changes (`changed`) are called as the reactor will call them; the
// processes a removal stops are in Leftovers.test.ts.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

const layer = (options: TaskTmpOptions = {}) =>
  Layer.effect(TaskTmp, TaskTmp.make(options)).pipe(Layer.provideMerge(Leftovers.layer), Layer.provideMerge(TestPlatform()))

type Env = TaskTmp | SqlClient.SqlClient | SecureRandom.SecureRandom | DataDir | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Env>, options: TaskTmpOptions = {}) => effect.pipe(Effect.scoped, Effect.provide(layer(options)))

interface T {
  readonly id: TaskId
  readonly kind: "task" | "review"
  readonly parent_id: TaskId | null
  readonly status: Status
}

/** A task in progress (a profile "p" made once); `id` to give its id. */
const newTask = (id?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const random = yield* SecureRandom.SecureRandom
    const task = TaskId.make(id ?? (yield* random.uuidV4()))
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at)
      VALUES (${task}, 'p', 'A task', 'in_progress', ${AT}, ${AT}, ${AT})`
    const t: T = { id: task, kind: "task", parent_id: null, status: "in_progress" }
    return t
  }).pipe(Effect.orDie)

const set = (id: TaskId, fields: { readonly status?: Status; readonly running?: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (fields.status !== undefined) yield* sql`UPDATE tasks SET status = ${fields.status} WHERE id = ${id}`
    if (fields.running !== undefined) yield* sql`UPDATE tasks SET running = ${fields.running ? 1 : 0} WHERE id = ${id}`
  }).pipe(Effect.orDie)

const uuid = Effect.flatMap(SecureRandom.SecureRandom, (r) => r.uuidV4())

const bytes = (s: string) => new TextEncoder().encode(s)

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

describe("TaskTmp", () => {
  it.effect("a review thread uses its task's folder", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const t = yield* newTask()
        const r = { id: TaskId.make("r"), kind: "review" as const, parent_id: t.id }
        assert.strictEqual(tmp.dir(r), tmp.dir(t))
        assert.strictEqual(tmp.dir(t), `${tmp.root}/${t.id.replaceAll("-", "").slice(0, 12)}`)
      }),
    ),
  )

  it.effect("the path leaves room for sockets in it", () =>
    Effect.gen(function* () {
      const d = `${rootIn("/tmp", "/home/someone-with-a-long-name/.local/share/issue-agent")}/${folder(yield* uuid)}`
      assert.strictEqual(d.length, "/tmp/ha-0123abcd/0123456789ab".length, d)
      // Chromium's socket (46 bytes), in ui-check.mjs's folder for the browser (20), fits in a socket path (107 bytes),
      // with room to spare.
      assert.isTrue(d.length + "/ia-ui-check-XXXXXX".length + "/org.chromium.Chromium.XXXXXX/SingletonSocket".length <= 100)
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )

  it.effect("the root is per data dir and stable", () =>
    Effect.sync(() => {
      assert.strictEqual(fnv1a(bytes("/home/me/.local/share/huntaway")), fnv1a(bytes("/home/me/.local/share/huntaway")))
      assert.notStrictEqual(fnv1a(bytes("/home/me/.local/share/huntaway")), fnv1a(bytes("/tmp/ia-test-x")))
      assert.strictEqual(fnv1a(bytes("")), 0xcbf29ce484222325n)
    }),
  )

  it.effect("tasks whose ids start alike share a folder until both are done", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const a = yield* newTask()
        const b = yield* newTask(`${a.id.slice(0, 14)}${(yield* uuid).slice(14)}`)
        const d = yield* tmp.ensure(a)
        assert.isNotNull(d)
        assert.strictEqual(yield* tmp.ensure(b), d)
        yield* set(a.id, { status: "done" })
        assert.strictEqual(yield* tmp.sweep, 0)
        yield* set(b.id, { status: "done" })
        assert.strictEqual(yield* tmp.sweep, 1)
        assert.isFalse(existsSync(d ?? ""))
      }),
    ),
  )

  it.effect("the folder goes once the task is done and idle", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const t = yield* newTask()
        const d = (yield* tmp.ensure(t)) ?? ""
        mkdirSync(`${d}/ia-test-1/repo`, { recursive: true })
        writeFileSync(`${d}/ia-test-1/repo/x`, "x")
        // Not while the agent still runs, though the task is done.
        yield* set(t.id, { running: true, status: "done" })
        yield* tmp.changed({ ...t, status: "done" })
        yield* tmp.idle
        assert.isTrue(existsSync(d))
        assert.strictEqual(yield* tmp.sweep, 0)
        // Its run ending takes it.
        yield* set(t.id, { running: false })
        yield* tmp.changed({ ...t, status: "done" })
        yield* tmp.idle
        assert.deepStrictEqual(readdirSync(tmp.root), [])
        // It's set up again if the agent runs again; a change while it's open leaves it.
        yield* set(t.id, { status: "in_progress" })
        assert.strictEqual(yield* tmp.ensure(t), d)
        yield* tmp.changed(t)
        yield* tmp.idle
        assert.isTrue(existsSync(d))
      }),
    ),
  )

  it.effect("a review thread's run ending takes its task's folder", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const sql = yield* SqlClient.SqlClient
        const t = yield* newTask()
        const r: T = { id: TaskId.make(yield* uuid), kind: "review", parent_id: t.id, status: "in_progress" }
        yield* sql`INSERT INTO tasks (id, profile_id, kind, parent_id, title, status, running, last_activity_at, created_at, updated_at)
          VALUES (${r.id}, 'p', 'review', ${t.id}, 'Review', 'in_progress', 1, ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
        const d = (yield* tmp.ensure(r)) ?? ""
        assert.strictEqual(d, tmp.dir(t))
        yield* set(t.id, { status: "done" })
        // Its reviewer still works in it.
        assert.strictEqual(yield* tmp.sweep, 0)
        yield* set(r.id, { running: false })
        yield* tmp.changed(r)
        yield* tmp.idle
        assert.isFalse(existsSync(d))
      }),
    ),
  )

  it.effect("a sweep takes done and deleted tasks' folders", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const [open, done] = [yield* newTask(), yield* newTask()]
        const [openDir, doneDir] = [(yield* tmp.ensure(open)) ?? "", (yield* tmp.ensure(done)) ?? ""]
        // Done while the server was down, so nothing saw it change.
        yield* set(done.id, { status: "done" })
        const deleted = `${tmp.root}/${folder(yield* uuid)}`
        mkdirSync(deleted, { recursive: true })
        const unfinished = `${tmp.root}/${REMOVING}x-1`
        mkdirSync(`${unfinished}/y`, { recursive: true })
        assert.strictEqual(yield* tmp.sweep, 2)
        assert.deepStrictEqual([existsSync(openDir), existsSync(doneDir), existsSync(deleted), existsSync(unfinished)], [true, false, false, false])
      }),
    ),
  )

  it.effect("only folders named like tasks are swept", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const data = yield* DataDir
        yield* tmp.ensure(yield* newTask())
        const elsewhere = `${data.root}/elsewhere`
        mkdirSync(`${elsewhere}/docs`, { recursive: true })
        writeFileSync(`${elsewhere}/docs/important.txt`, "x")
        mkdirSync(`${tmp.root}/notes`)
        symlinkSync(elsewhere, `${tmp.root}/${folder(yield* uuid)}`)
        assert.strictEqual(yield* tmp.sweep, 0)
        assert.isTrue(isDir(`${tmp.root}/notes`) && existsSync(`${elsewhere}/docs/important.txt`))
      }),
    ),
  )

  it.effect("nothing is removed through a root that isn't ours alone", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const data = yield* DataDir
        const t = yield* newTask()
        yield* set(t.id, { status: "done" })
        // Someone left a link where the root goes, to a folder with a done task's name in it.
        const elsewhere = `${data.root}/elsewhere`
        for (const d of [folder(t.id), folder(yield* uuid), `${REMOVING}x`, "docs"]) {
          mkdirSync(`${elsewhere}/${d}`, { recursive: true })
          writeFileSync(`${elsewhere}/${d}/important.txt`, "x")
        }
        const count = () => readdirSync(elsewhere).length
        symlinkSync(elsewhere, tmp.root)
        assert.strictEqual(yield* tmp.sweep, 0)
        assert.isFalse(yield* tmp.remove(folder(t.id)))
        assert.strictEqual(count(), 4)
        assert.isNull(yield* tmp.ensure(yield* newTask()))
        // Nor through a root others can write to.
        unlinkSync(tmp.root)
        renameSync(elsewhere, tmp.root)
        chmodSync(tmp.root, 0o777)
        assert.strictEqual(yield* tmp.sweep, 0)
        assert.strictEqual(readdirSync(tmp.root).length, 4)
        assert.isNull(yield* tmp.ensure(yield* newTask()))
        // Once it's ours alone, the done task's folder goes, and the one of a task that isn't there.
        chmodSync(tmp.root, 0o700)
        assert.strictEqual(yield* tmp.sweep, 2)
        assert.isTrue(existsSync(`${tmp.root}/docs/important.txt`))
      }),
    ),
  )

  it.effect("a run starting as the folder goes keeps its own", () =>
    Effect.gen(function* () {
      // Once the removal has found the task idle, a run starts: it's registered, then sets up its folder and writes in
      // it. It waits for the removal's lock, so it gets a new folder rather than one about to go.
      const hook = yield* Ref.make<Effect.Effect<void>>(Effect.void)
      const started = yield* Deferred.make<string | null>()
      yield* Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const sql = yield* SqlClient.SqlClient
        const t = yield* newTask()
        yield* tmp.ensure(t)
        yield* set(t.id, { status: "done" })
        const start = Effect.gen(function* () {
          yield* set(t.id, { running: true })
          const d = yield* tmp.ensure(t)
          if (d !== null) writeFileSync(`${d}/work`, "x")
          yield* Deferred.succeed(started, d)
        })
        yield* Ref.set(
          hook,
          Effect.asVoid(Effect.andThen(Ref.set(hook, Effect.void), Effect.forkDetach(Effect.provideService(start, SqlClient.SqlClient, sql)))),
        )
        assert.strictEqual(yield* tmp.sweep, 1)
        assert.strictEqual(yield* Deferred.await(started), tmp.dir(t))
        assert.isTrue(existsSync(`${tmp.dir(t)}/work`))
        // And with it running, the folder stays.
        assert.strictEqual(yield* tmp.sweep, 0)
        assert.isTrue(existsSync(`${tmp.dir(t)}/work`))
      }).pipe(Effect.scoped, Effect.provide(layer({ onRemovable: Effect.flatten(Ref.get(hook)) })))
    }),
  )

  it.effect("deleting a task takes its folder", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const sql = yield* SqlClient.SqlClient
        const [kept, gone] = [yield* newTask(), yield* newTask()]
        const [keptDir, goneDir] = [(yield* tmp.ensure(kept)) ?? "", (yield* tmp.ensure(gone)) ?? ""]
        writeFileSync(`${goneDir}/x`, "x")
        yield* sql`DELETE FROM tasks WHERE id = ${gone.id}`.pipe(Effect.orDie)
        yield* tmp.deleted(gone.id)
        assert.isTrue(existsSync(keptDir) && !existsSync(goneDir))
        assert.strictEqual(readdirSync(tmp.root).length, 1)
      }),
    ),
  )

  it.effect("folders without write permission are removed too", () =>
    run(
      Effect.gen(function* () {
        const tmp = yield* TaskTmp
        const t = yield* newTask()
        const d = (yield* tmp.ensure(t)) ?? ""
        mkdirSync(`${d}/mod/pkg`, { recursive: true })
        writeFileSync(`${d}/mod/pkg/f`, "x")
        for (const p of ["mod/pkg", "mod"]) chmodSync(`${d}/${p}`, 0o555)
        yield* set(t.id, { status: "done" })
        assert.strictEqual(yield* tmp.sweep, 1)
        assert.deepStrictEqual(readdirSync(tmp.root), [])
      }),
    ),
  )
})
