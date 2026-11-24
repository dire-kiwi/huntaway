import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { watchBoard } from "../src/board/watch.ts"
import { fakeHost } from "./fakeHost.ts"

// HE-104: a host whose snapshot this end can't read (it was longer than the RPC's limit) was asked for it again at
// once, for ever, each time reading and sending the whole board. A subscription that ends before anything after
// `hello` waits before the next, twice as long each time, up to 30 seconds; one that gets going starts over at 1.
describe("watchBoard", () => {
  it.effect("subscribes again later and later while the snapshot can't be read, then at once once it can", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      a.unreadable = true
      const subscribed = (n: number) => Effect.gen(function* () {
        while (a.subscriptions.length < n) yield* Effect.yieldNow
      })
      yield* watchBoard(a.id, undefined).pipe(Stream.runDrain, Effect.provide(a.layer), Effect.forkScoped)
      yield* subscribed(1)
      for (const wait of [1, 2, 4, 8, 16, 30, 30]) {
        const before = a.subscriptions.length
        yield* TestClock.adjust(`${wait - 0.5} seconds`)
        expect(a.subscriptions.length).toBe(before)
        yield* TestClock.adjust("0.5 seconds")
        yield* subscribed(before + 1)
      }
      // Readable again: the next one loads it, and a drop after that subscribes again at once.
      a.unreadable = false
      yield* TestClock.adjust("30 seconds")
      yield* subscribed(9)
      yield* a.drop
      yield* a.reconnect
      yield* subscribed(10)
    }).pipe(Effect.scoped),
  )
})
