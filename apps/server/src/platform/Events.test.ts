import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { ProfileId } from "@huntaway/contracts"
import { Db } from "./Db.ts"
import { Events } from "./Events.ts"

const TestLive = Events.layer.pipe(Layer.provideMerge(Db.layerMemory), Layer.provideMerge(SecureRandom.layerWebCrypto))
const pens = (id: string) => ({ type: "pens" as const, profile_id: ProfileId.make(id) })

describe("Events", () => {
  it.effect("numbers events and delivers them to a subscriber", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const watch = yield* events.watch(undefined)
      yield* events.emit(pens("a"))
      yield* events.emit({ type: "settings_changed" })
      const seen = yield* watch.live.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e) => [e.type, e.seq]),
        [
          ["pens", 1],
          ["settings_changed", 2],
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
          yield* events.emit(pens("in-tx"))
          assert.strictEqual(yield* events.seq, 0, "not published before the commit")
        }),
      )
      assert.strictEqual(yield* events.seq, 1)
      yield* db.tx(Effect.andThen(events.emit(pens("rolled-back")), Effect.fail("no"))).pipe(Effect.ignore)
      yield* events.emit(pens("after"))
      const seen = yield* watch.live.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        seen.map((e) => (e.type === "pens" ? e.profile_id : e.type)),
        ["in-tx", "after"],
      )
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  )

  it.effect("replays from a `since` of this boot, and asks for a snapshot otherwise", () =>
    Effect.gen(function* () {
      const events = yield* Events
      yield* events.emit(pens("1"))
      yield* events.emit(pens("2"))
      yield* events.emit(pens("3"))
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
})
