import { Effect, Queue } from "effect"
import type { Cause } from "effect"
import { Socket } from "effect/socket"

/** A frame the server sent: output or a text frame, or the close it ended with. */
export type SentFrame = Uint8Array | string | Socket.CloseEvent

/** A websocket held in memory (6.1, terminals): what the server's side reads and writes, and the client's side of it. */
export interface FakeSocket {
  readonly socket: Socket.Socket
  readonly reader: Socket.Reader
  readonly writer: Socket.Writer
  /** The client sends a frame. */
  readonly send: (frame: Uint8Array | string) => Effect.Effect<void>
  /** The client goes away: the server's next read fails as a closed socket's does. */
  readonly hangUp: Effect.Effect<void>
  /** What the server sent, in order: take from it to wait for the next frame. */
  readonly sent: Queue.Dequeue<SentFrame>
}

const closed = (code: number) => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })

/** A fresh `FakeSocket`. A close the server writes ends the client's side too. */
export const fakeSocket: Effect.Effect<FakeSocket> = Effect.gen(function* () {
  const inbox = yield* Queue.unbounded<Uint8Array | string, Cause.Done>()
  const sent = yield* Queue.unbounded<SentFrame>()
  const reader: Socket.Reader = {
    pull: Queue.take(inbox).pipe(
      Effect.map((frame) => [frame] as const),
      Effect.mapError(() => closed(1000)),
    ),
    upgrade: () => Effect.fail(new Socket.SocketError({ reason: new Socket.SocketUpgradeError({}) })),
  }
  const write = (chunk: SentFrame) =>
    Effect.gen(function* () {
      yield* Queue.offer(sent, chunk)
      if (Socket.isCloseEvent(chunk)) yield* Queue.end(inbox)
    })
  const writer: Socket.Writer = { write, writeAll: (chunks) => Effect.forEach(chunks, write, { concurrency: 1, discard: true }) }
  return {
    socket: Socket.make({ reader: Effect.succeed(reader), writer: Effect.succeed(writer) }),
    reader,
    writer,
    send: (frame) => Queue.offer(inbox, frame).pipe(Effect.asVoid),
    hangUp: Queue.end(inbox).pipe(Effect.asVoid),
    sent,
  }
})
