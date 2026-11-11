import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { coalesced, DELAY } from "./SettingsSyncExchange.ts"

// The hub's exchange is debounced and single-flight (the old `schedule`: a timer, `running` and `again`).

describe("the exchange's schedule", () => {
  it.effect("triggers close together run it once, after the delay; one while it runs runs it again after", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const started = yield* Queue.unbounded<number>()
      const release = yield* Queue.unbounded<void>()
      // Each run says it started, then waits to be let go.
      const run = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(runs, (x) => x + 1)
        yield* Queue.offer(started, n)
        yield* Queue.take(release)
      })
      const trigger = yield* coalesced(run, DELAY)
      const next = Stream.fromQueue(started).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)

      for (let i = 0; i < 3; i++) yield* trigger
      yield* TestClock.adjust("199 millis")
      assert.strictEqual(yield* Ref.get(runs), 0)
      yield* TestClock.adjust("1 millis")
      assert.deepStrictEqual(yield* Fiber.join(yield* next), [1])

      // Two more while it runs: one more run, after it, and after the delay.
      yield* trigger
      yield* trigger
      yield* Queue.offer(release, undefined)
      const again = yield* Stream.fromQueue(started).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust(DELAY)
      assert.deepStrictEqual(yield* Fiber.join(again), [2])
      yield* Queue.offer(release, undefined)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Ref.get(runs), 2)
    }).pipe(Effect.scoped),
  )
})
