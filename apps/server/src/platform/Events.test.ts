import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { AgentConfigId, ProjectId, TaskId } from "@huntaway/contracts"
import { Db } from "./Db.ts"
import { BACKLOG, Events, TAIL } from "./Events.ts"

const TestLive = Events.layer.pipe(Layer.provideMerge(Db.layerMemory), Layer.provideMerge(SecureRandom.layerWebCrypto))
const gone = (id: string) => ({ type: "project_deleted" as const, id: ProjectId.make(id) })
const taskGone = (id: string) => ({ type: "task_deleted" as const, id: TaskId.make(id), project_id: null })
const usage = (config: string, plan: string) => ({
  type: "usage" as const,
  usage: { config_id: AgentConfigId.make(config), limits: [], plan, updated_at: null, error: null, out_until: null, accounts: null },
})

describe("Events", () => {
  it.effect("numbers events and delivers them to a subscriber", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const watch = yield* events.watch(undefined)
      yield* events.emit(gone("a"))
      yield* events.emit(gone("b"))
      const seen = yield* watch.live.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e) => [e.type, e.seq]),
        [
          ["project_deleted", 1],
          ["project_deleted", 2],
        ],
      )
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("inside a transaction, publishes after the commit, and nothing on a rollback", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const db = yield* Db
      const watch = yield* events.watch(undefined)
      yield* db.tx(
        Effect.gen(function* () {
          yield* events.emit(gone("in-tx"))
          assert.strictEqual(yield* events.seq, 0, "not published before the commit")
        }),
      )
      assert.strictEqual(yield* events.seq, 1)
      yield* db.tx(Effect.andThen(events.emit(gone("rolled-back")), Effect.fail("no"))).pipe(Effect.ignore)
      yield* events.emit(gone("after"))
      const seen = yield* watch.live.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e) => (e.type === "project_deleted" ? e.id : e.type)),
        ["in-tx", "after"],
      )
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("replays from a `since` of this boot, and asks for a snapshot otherwise", () =>
    Effect.gen(function* () {
      const events = yield* Events
      yield* events.emit(gone("1"))
      yield* events.emit(gone("2"))
      yield* events.emit(gone("3"))
      const resumed = yield* events.watch({ boot: events.boot, seq: 1 })
      assert.deepStrictEqual(
        resumed.replay?.map((e) => e.seq),
        [2, 3],
      )
      assert.strictEqual(resumed.seq, 3)
      const otherBoot = yield* events.watch({ boot: "another", seq: 1 })
      assert.strictEqual(otherBoot.replay, null)
      const ahead = yield* events.watch({ boot: events.boot, seq: 99 })
      assert.strictEqual(ahead.replay, null)
      const fresh = yield* events.watch(undefined)
      assert.strictEqual(fresh.replay, null)
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("a subscriber that falls too far behind is cut off with resync", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const watch = yield* events.watch(undefined)
      for (let i = 0; i <= BACKLOG; i++) yield* events.emit(gone(String(i)))
      const seen = yield* watch.live.pipe(Stream.runCollect)
      assert.strictEqual(seen.length, BACKLOG + 1)
      assert.strictEqual(seen.at(-1)?.type, "resync")
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("a replay leaves out an event a later one with the same task or config replaces (HE-104)", () =>
    Effect.gen(function* () {
      const events = yield* Events
      yield* events.emit(usage("c1", "pro")) // 1
      yield* events.emit(gone("p")) // 2
      yield* events.emit(taskGone("t1")) // 3
      yield* events.emit(usage("c1", "max")) // 4, replaces 1
      yield* events.emit(usage("c2", "pro")) // 5
      yield* events.emit(taskGone("t1")) // 6, replaces 3
      const all = yield* events.watch({ boot: events.boot, seq: 0 })
      assert.deepStrictEqual(
        all.replay?.map((e) => e.seq),
        [2, 4, 5, 6],
      )
      const later = yield* events.watch({ boot: events.boot, seq: 3 })
      assert.deepStrictEqual(
        later.replay?.map((e) => e.seq),
        [4, 5, 6],
      )
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("keeps TAIL events besides those replaced; a since before the oldest dropped can't be replayed", () =>
    Effect.gen(function* () {
      const events = yield* Events
      // Replaced ones don't count: a task changing again and again leaves room for every other event.
      for (let i = 0; i < 3 * TAIL; i++) yield* events.emit(taskGone("busy"))
      for (let i = 0; i < TAIL - 1; i++) yield* events.emit(gone(String(i)))
      const whole = yield* events.watch({ boot: events.boot, seq: 0 })
      assert.strictEqual(whole.replay?.length, TAIL)
      assert.strictEqual(whole.replay?.[0]?.seq, 3 * TAIL)
      // One more drops the oldest kept (the busy task's last), which a `since` before it needed.
      yield* events.emit(gone("last"))
      assert.strictEqual((yield* events.watch({ boot: events.boot, seq: 3 * TAIL - 1 })).replay, null)
      const after = yield* events.watch({ boot: events.boot, seq: 3 * TAIL })
      assert.strictEqual(after.replay?.length, TAIL)
      assert.strictEqual(after.replay?.at(-1)?.seq, 4 * TAIL)
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )
})
