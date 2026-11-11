import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { KeyedLock } from "./KeyedLock.ts"

describe("KeyedLock", () => {
  it.effect("one holder per key; other keys go ahead", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedLock
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (s: string) => Ref.update(log, (l) => [...l, s])
      const release = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const first = yield* locks
        .withLock(["task", "a"])(Effect.andThen(Deferred.succeed(held, undefined), Effect.andThen(Deferred.await(release), note("first done"))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(held)
      const second = yield* locks.withLock(["task", "a"])(note("second")).pipe(Effect.forkChild)
      yield* locks.withLock(["task", "b"])(note("other key"))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(log), ["other key"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.deepStrictEqual(yield* Ref.get(log), ["other key", "first done", "second"])
    }).pipe(Effect.provide(KeyedLock.layer)),
  )

  it.effect("released when the work fails", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedLock
      yield* locks.withLock(["project", "p"])(Effect.fail("boom")).pipe(Effect.ignore)
      const value = yield* locks.withLock(["project", "p"])(Effect.succeed(1))
      assert.strictEqual(value, 1)
    }).pipe(Effect.provide(KeyedLock.layer)),
  )
})
