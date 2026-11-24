import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest"
import * as NodeWS from "@effect/platform-node/NodeWS"
import { Array as Arr, Effect, Layer } from "effect"
import type { Duration } from "effect"
import { RPC_MAX_MESSAGE } from "@huntaway/contracts"
import { HttpServerRequest } from "effect/http"
import type { HttpServerError } from "effect/http"
import { Socket } from "effect/socket"

// Two websockets piped frame for frame, for the relay (docs/plan/08-hosts.md, Relay). Checked in 7.0
// (`pipe.test.ts`): Effect's websocket `Reader` stops reading a peer (pauses it) while its frames wait unread, but its
// `Writer` hands a frame to `ws.send` and returns, so a pipe of `reader.pull` into `writer.writeAll` alone reads a fast
// peer as fast as it sends and keeps whatever the slow side has not taken in memory. Here each write also waits for the
// connection under the slow side to drain, so a slow reader slows the sender, in both directions.
//
// A piped socket is never compressed (HE-71). With permessage-deflate, `ws.send` queues a frame for zlib and the
// connection's buffer stays empty until it is deflated, so the wait for a drain doesn't see it: a sender faster than
// zlib is read as fast as it sends, into that queue. The listeners offer deflate (`http/websocket.ts`), so `accept`
// takes the extension out of the request before it upgrades, and `dial` doesn't offer it.
//
// A listener takes a message of at most 16 MiB (`http/websocket.ts`), but an RPC answer can be far longer (a big
// board's snapshot). A pipe into a peer's listener (an answer to its request for a socket) is told to `split` an RPC
// socket's frames: RPC's NDJSON joins the parts of a line however it is cut (`splitFrame`). `dial` takes a message as
// long as RPC does, for the same answers coming the other way.

/**
 * `NodeWS.layerWebSocketConstructor` taking a message as long as RPC does: `ws`'s own limit is 100 MiB, less than RPC's
 * (`RPC_MAX_MESSAGE`). For the RPC clients of links (`LinkConnections`, `Hubs`).
 */
export const layerRpcWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> = Layer.succeed(Socket.WebSocketConstructor)((url, options) =>
  options === undefined || typeof options === "string" || Array.isArray(options)
    ? new NodeWS.WebSocket(url, options, { maxPayload: RPC_MAX_MESSAGE })
    : new NodeWS.WebSocket(url, options.protocols, { headers: options.headers, maxPayload: RPC_MAX_MESSAGE }),
)

/** Whether the socket at `path` speaks RPC (its own, or a relay's), so its frames may be cut anywhere: see `splitFrame`. */
export const speaksRpc = (path: string): boolean => path === "/api/rpc" || path.startsWith("/api/relay/")

/**
 * The longest frame a splitting pipe passes on whole: 4 Mi string code units, at most 12 MiB as UTF-8, or 4 MiB of
 * bytes. Within a listener's 16 MiB.
 */
export const SPLIT_AT = 4 * 1024 * 1024

/**
 * `frame` cut in parts of at most `max` code units (a string, never between the two halves of a surrogate pair) or bytes,
 * for an RPC socket: its NDJSON joins the parts of a line, and decodes bytes as one stream.
 */
export const splitFrame = (frame: string | Uint8Array, max: number = SPLIT_AT): Arr.NonEmptyReadonlyArray<string | Uint8Array> => {
  const length = typeof frame === "string" ? frame.length : frame.byteLength
  if (length <= max) return [frame]
  const parts: Array<string | Uint8Array> = []
  let start = 0
  while (start < length) {
    let end = Math.min(start + max, length)
    if (typeof frame === "string") {
      const last = frame.charCodeAt(end - 1)
      if (end < length && last >= 0xd800 && last <= 0xdbff) end -= 1
      parts.push(frame.slice(start, end))
    } else parts.push(frame.subarray(start, end))
    start = end
  }
  return Arr.isArrayNonEmpty(parts) ? parts : [frame]
}
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
  // `ws` negotiates from the headers of the request it is given, as the upgrade happens.
  delete incoming.headers["sec-websocket-extensions"]
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
    /** Subprotocols to ask for (a Space's media socket's `rcdp.v2`). */
    readonly protocols?: ReadonlyArray<string>
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
          const ws = new NodeWS.WebSocket(url, [...(options.protocols ?? [])], {
            headers: { ...options.headers },
            perMessageDeflate: false,
            maxPayload: RPC_MAX_MESSAGE,
          })
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

/**
 * Copies `from`'s frames to `to` until `from` ends, then closes `to` as `from` was closed. With `split`, frames longer
 * than it are cut (`splitFrame`).
 */
const forward = (from: Pipeable, to: Pipeable, onWrite: (bytes: number) => Effect.Effect<void>, split: number | undefined): Effect.Effect<Ended> =>
  Effect.gen(function* () {
    const reader = yield* from.socket.reader
    const writer = yield* to.socket.writer
    const ended = yield* Effect.gen(function* () {
      for (;;) {
        const pulled = yield* reader.pull
        const frames = split === undefined ? pulled : Arr.flatMap(pulled, (frame) => splitFrame(frame, split))
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
 * told the size of each batch written (tests watch it). `split` cuts longer frames (`splitFrame`): only for RPC.
 */
export const pipe = (
  a: Pipeable,
  b: Pipeable,
  options: { readonly onWrite?: (bytes: number) => Effect.Effect<void>; readonly split?: number } = {},
): Effect.Effect<Ended> => {
  const onWrite = options.onWrite ?? (() => Effect.void)
  return Effect.raceFirst(forward(a, b, onWrite, options.split), forward(b, a, onWrite, options.split))
}
