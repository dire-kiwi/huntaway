import { NodeHttpServerRequest, NodeWS } from "@effect/platform-node"
import { Effect } from "effect"
import type { Duration } from "effect"
import { HttpServerRequest } from "effect/http"
import type { HttpServerError } from "effect/http"
import { Socket } from "effect/socket"

// Two websockets piped frame for frame, for the relay (docs/plan/08-hosts.md, Relay). Checked in 7.0
// (`pipe.test.ts`): Effect's websocket `Reader` stops reading a peer (pauses it) while its frames wait unread, but its
// `Writer` hands a frame to `ws.send` and returns, so a pipe of `reader.pull` into `writer.writeAll` alone reads a fast
// peer as fast as it sends and keeps whatever the slow side has not taken in memory. Here each write also waits for the
// connection under the slow side to drain, so a slow reader slows the sender, in both directions.

/** The connection under a websocket: what a write waits on to drain. A Node `net.Socket` is one. */
export interface Transport {
  readonly writableNeedDrain: boolean
  readonly writableLength: number
  readonly destroyed: boolean
  once(event: "drain" | "close" | "pause", listener: () => void): unknown
  off(event: "drain" | "close" | "pause", listener: () => void): unknown
}

/** One end of a pipe: the socket, and the connection under it once it is open. */
export interface Pipeable {
  readonly socket: Socket.Socket
  readonly transport: () => Transport | undefined
}

/** Waits until `transport` has room again (or has closed). */
const drained = (transport: Transport | undefined): Effect.Effect<void> =>
  transport === undefined || transport.destroyed || !transport.writableNeedDrain
    ? Effect.void
    : Effect.callback<void>((resume) => {
        const stop = () => {
          transport.off("drain", done)
          transport.off("close", done)
        }
        const done = () => {
          stop()
          resume(Effect.void)
        }
        transport.once("drain", done)
        transport.once("close", done)
        return Effect.sync(stop)
      })

/** The websocket this request upgrades to, as one end of a pipe. */
export const accept: Effect.Effect<Pipeable, HttpServerError.HttpServerError, HttpServerRequest.HttpServerRequest> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const incoming = NodeHttpServerRequest.toIncomingMessage(request)
  const socket = yield* request.upgrade
  return { socket, transport: () => incoming.socket }
})

/**
 * A websocket to `url` with `headers` on its upgrade request, as one end of a pipe. It connects when the pipe first
 * reads it, within `openTimeout`; `onOpen` is given the connection under it.
 */
export const dial = (
  url: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>
    readonly openTimeout?: Duration.Input
    readonly onOpen?: (transport: Transport) => void
  } = {},
) =>
  Effect.gen(function* () {
    // Set by `ws` once the upgrade is answered; read by the writes after.
    const under: { current: Transport | undefined } = { current: undefined }
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() => {
          const ws = new NodeWS.WebSocket(url, { headers: { ...options.headers } })
          ws.once("upgrade", (response) => {
            under.current = response.socket
            options.onOpen?.(response.socket)
          })
          // An error before open is the reader's to report; this keeps a late one from being unhandled.
          ws.on("error", () => undefined)
          return ws
        }),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
      { openTimeout: options.openTimeout ?? "30 seconds" },
    )
    return { socket, transport: () => under.current } satisfies Pipeable
  })

/** How a pipe ended: the close code and reason one side gave, passed on to the other. */
export interface Ended {
  readonly code: number
  readonly reason: string
}

/** A code a peer may be sent: 1005, 1006 and 1015 are only ever reported, never sent. */
const sendable = (code: number): number =>
  code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : 1011

const endedBy = (error: Socket.SocketError): Ended =>
  error.reason._tag === "SocketCloseError"
    ? { code: error.reason.code, reason: error.reason.closeReason ?? "" }
    : { code: 1011, reason: error.reason._tag === "SocketOpenError" ? "could not connect" : "connection lost" }

/** Copies `from`'s frames to `to` until `from` ends, then closes `to` as `from` was closed. */
const forward = (from: Pipeable, to: Pipeable, onWrite: (bytes: number) => Effect.Effect<void>): Effect.Effect<Ended> =>
  Effect.gen(function* () {
    const reader = yield* from.socket.reader
    const writer = yield* to.socket.writer
    const ended = yield* Effect.gen(function* () {
      for (;;) {
        const frames = yield* reader.pull
        yield* writer.writeAll(frames)
        yield* onWrite(frames.reduce((n, frame) => n + (typeof frame === "string" ? frame.length : frame.byteLength), 0))
        yield* drained(to.transport())
      }
    }).pipe(Effect.catch((error) => Effect.succeed(endedBy(error))))
    yield* writer.write(new Socket.CloseEvent(sendable(ended.code), ended.reason.slice(0, 120))).pipe(Effect.ignore)
    return ended
  }).pipe(
    Effect.catch((error) => Effect.succeed(endedBy(error))),
    Effect.scoped,
  )

/**
 * Pipes `a` and `b` both ways until either closes, then closes the other with the same code and reason. `onWrite` is
 * told the size of each batch written (tests watch it).
 */
export const pipe = (a: Pipeable, b: Pipeable, options: { readonly onWrite?: (bytes: number) => Effect.Effect<void> } = {}): Effect.Effect<Ended> => {
  const onWrite = options.onWrite ?? (() => Effect.void)
  return Effect.raceFirst(forward(a, b, onWrite), forward(b, a, onWrite))
}
