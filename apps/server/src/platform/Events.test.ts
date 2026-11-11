import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { ProjectId } from "@huntaway/contracts"
import { Db } from "./Db.ts"
import { BACKLOG, Events } from "./Events.ts"

const TestLive = Events.layer.pipe(Layer.provideMerge(Db.layerMemory), Layer.provideMerge(SecureRandom.layerWebCrypto))
const gone = (id: string) => ({ type: "project_deleted" as const, id: ProjectId.make(id) })

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
})
