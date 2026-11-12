import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Ref, Stream } from "effect"
import type { Cause } from "effect"
import { TestClock } from "effect/testing"
import { fakeSocket } from "@huntaway/testing"
import { MAX_UNACKED, PING, relay } from "./attach.ts"
import type { PtyProcess } from "./Pty.ts"

// A terminal's socket relayed to its pty (the old hosts/terminal.ts `attach`), with a pty and a socket in memory and
// the test clock: output and input, resizes, flow control by acknowledgements, pings and a silent board.

const fakePty = Effect.gen(function* () {
  const out = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const typed = yield* Queue.unbounded<string>()
  const sizes = yield* Queue.unbounded<string>()
  const pty: PtyProcess = {
    output: Stream.fromQueue(out),
    write: (data) => Queue.offer(typed, new TextDecoder().decode(data)).pipe(Effect.asVoid),
    resize: (cols, rows) => Queue.offer(sizes, `${cols}x${rows}`).pipe(Effect.asVoid),
    exited: Effect.void,
  }
  return { pty, out, typed, sizes }
})

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (frame: unknown) => (frame instanceof Uint8Array ? new TextDecoder().decode(frame) : String(frame))

/** Lets the relay's fibers run as far as they can. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

const start = Effect.gen(function* () {
  const p = yield* fakePty
  const s = yield* fakeSocket
  const pings = yield* Ref.make(0)
  const fiber = yield* relay(
    p.pty,
    s.reader,
    s.writer,
    Ref.update(pings, (n) => n + 1),
  ).pipe(Effect.forkChild)
  return { ...p, ...s, pings, fiber }
})

describe("relay", () => {
  it.effect("relays output and input and resizes, and ends when the session does", () =>
    Effect.gen(function* () {
      const t = yield* start
      yield* Queue.offer(t.out, bytes("$ "))
      assert.strictEqual(text(yield* Queue.take(t.sent)), "$ ")
      yield* t.send(bytes("ls\r"))
      assert.strictEqual(yield* Queue.take(t.typed), "ls\r")
      // A size that makes no sense, and a frame that isn't one of ours, are left alone; a huge one is clamped.
      yield* t.send('{"type":"resize","cols":1,"rows":30}')
      yield* t.send("not json")
      yield* t.send('{"type":"resize","cols":120,"rows":40}')
      assert.strictEqual(yield* Queue.take(t.sizes), "120x40")
      yield* t.send('{"type":"resize","cols":5000,"rows":40}')
      assert.strictEqual(yield* Queue.take(t.sizes), "1000x40")
      // The shell exited: the pty's output ends.
      yield* Queue.end(t.out)
      assert.strictEqual(yield* Fiber.join(t.fiber), "ended")
    }),
  )

  it.effect("stops reading the pty while 384 KiB is unacknowledged, and goes on once the board has drawn some", () =>
    Effect.gen(function* () {
      const t = yield* start
      const chunk = new Uint8Array(MAX_UNACKED / 3)
      for (let i = 0; i < 4; i++) yield* Queue.offer(t.out, chunk)
      for (let i = 0; i < 3; i++) yield* Queue.take(t.sent)
      yield* settle
      assert.strictEqual(yield* Queue.size(t.sent), 0, "the fourth chunk waits")
      // An acknowledgement that leaves it at the limit isn't enough.
      yield* t.send('{"type":"ack","bytes":0}')
      yield* settle
      assert.strictEqual(yield* Queue.size(t.sent), 0)
      yield* t.send(`{"type":"ack","bytes":${chunk.length}}`)
      assert.strictEqual(text(yield* Queue.take(t.sent)).length, chunk.length)
      yield* t.hangUp
      assert.strictEqual(yield* Fiber.join(t.fiber), "closed")
    }),
  )

  it.effect("pings every 15 seconds; a board that answered once and then went silent for a minute is closed", () =>
    Effect.gen(function* () {
      const t = yield* start
      yield* TestClock.adjust("15 seconds")
      assert.strictEqual(yield* Queue.take(t.sent), PING)
      yield* t.send('{"type":"pong"}')
      yield* settle
      // 60 seconds since its pong is still within the minute.
      for (let i = 0; i < 4; i++) {
        yield* TestClock.adjust("15 seconds")
        assert.strictEqual(yield* Queue.take(t.sent), PING)
      }
      yield* TestClock.adjust("15 seconds")
      assert.strictEqual(yield* Fiber.join(t.fiber), "silent")
      assert.strictEqual(yield* Ref.get(t.pings), 5, "each ping renews a tool's lease")
    }),
  )

  it.effect("a board that never answers a ping isn't held to it", () =>
    Effect.gen(function* () {
      const t = yield* start
      yield* TestClock.adjust("10 minutes")
      yield* settle
      assert.isUndefined(t.fiber.pollUnsafe())
      assert.strictEqual(yield* Ref.get(t.pings), 40)
      yield* t.hangUp
      assert.strictEqual(yield* Fiber.join(t.fiber), "closed")
    }),
  )
})
