import { Clock, Effect, Option, Queue, Ref, Schema, Stream } from "effect"
import type { Socket } from "effect/socket"
import { TerminalClientFrame } from "@huntaway/contracts"
import type { PtyProcess } from "./Pty.ts"
import type { PtyFailed } from "./Pty.ts"
import { resize } from "./tmux.ts"

// A terminal's socket relayed to its pty (huntaway's hosts/terminal.ts `attach`): output as binary frames, input from
// binary frames, and JSON text frames for the rest (`TerminalClientFrame`). The client acknowledges output once xterm
// has drawn it, and the pty isn't read while too much is unacknowledged, so a flood of output can't pile up in the
// browser. A `ping` every 15 seconds, which the board answers with `pong`: a hub's relay may answer websocket pings
// itself, so only the `pong` says the browser is still there (a phone that slept with the terminal open never closes
// it). A board that has never answered one isn't held to it.

/** Output sent ahead of the client's acknowledgements. */
export const MAX_UNACKED = 384 * 1024
export const PING_EVERY = "15 seconds"
/** How long a board that has answered a `ping` may go without answering before its terminal is closed. */
export const PONG_WITHIN_MS = 60_000

export const READY = '{"type":"ready"}'
export const PING = '{"type":"ping"}'

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalClientFrame))

/** How a relay ended: the session's command exited (or the session was killed), the socket closed, the board went silent. */
export type RelayEnd = "ended" | "closed" | "silent"

/**
 * Relay `pty` and the socket until one of them ends; `onPing` runs with each ping (a tool's session renews its lease).
 * The caller says `ready` first and closes the socket after.
 */
export const relay = Effect.fnUntraced(function* (
  pty: PtyProcess,
  reader: Socket.Reader,
  writer: Socket.Writer,
  onPing: Effect.Effect<void>,
): Effect.fn.Return<RelayEnd, PtyFailed> {
  const unacked = yield* Ref.make(0)
  // An acknowledgement came: the output loop looks again (one waiting is enough, so none is lost between its look and its wait).
  const acked = yield* Queue.sliding<void>(1)
  const pongedAt = yield* Ref.make<number | null>(null)

  const send = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      while ((yield* Ref.get(unacked)) >= MAX_UNACKED) yield* Queue.take(acked)
      yield* writer.write(chunk)
      yield* Ref.update(unacked, (n) => n + chunk.length)
    })
  const output = pty.output.pipe(
    Stream.runForEach(send),
    Effect.as<RelayEnd>("ended"),
    Effect.catchTag("SocketError", () => Effect.succeed<RelayEnd>("closed")),
  )

  const frame = (data: Uint8Array | string) =>
    Effect.gen(function* () {
      if (typeof data !== "string") {
        yield* pty.write(data)
        return
      }
      const m = decodeFrame(data)
      if (Option.isNone(m)) return
      const f = m.value
      if (f.type === "resize") {
        const to = resize(f.cols, f.rows)
        if (to !== null) yield* pty.resize(to.cols, to.rows)
      } else if (f.type === "pong") {
        yield* Ref.set(pongedAt, yield* Clock.currentTimeMillis)
      } else if (f.bytes >= 0) {
        yield* Ref.update(unacked, (n) => Math.max(0, n - f.bytes))
        yield* Queue.offer(acked, undefined)
      }
    })
  const input = reader.pull.pipe(
    Effect.flatMap((frames) => Effect.forEach(frames, frame, { concurrency: 1, discard: true })),
    Effect.forever,
    Effect.orElseSucceed((): RelayEnd => "closed"),
  )

  const heard = Effect.gen(function* () {
    yield* Effect.sleep(PING_EVERY)
    const ponged = yield* Ref.get(pongedAt)
    if (ponged !== null && (yield* Clock.currentTimeMillis) - ponged > PONG_WITHIN_MS) return false
    yield* onPing
    yield* writer.write(PING).pipe(Effect.ignore)
    return true
  })
  const ping = heard.pipe(Effect.repeat({ while: (alive) => alive }), Effect.as<RelayEnd>("silent"))

  return yield* Effect.raceAllFirst([output, input, ping])
})
