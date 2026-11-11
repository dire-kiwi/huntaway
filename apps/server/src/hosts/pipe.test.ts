import { NodeHttpServer, NodeWS } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { accept, dial, pipe } from "./pipe.ts"
import type { Pipeable, Transport } from "./pipe.ts"

// 7.0, the second check (docs/plan/08-hosts.md, To check early): two piped websockets keep back-pressure in both
// directions, with a terminal's output (binary frames, a JSON text frame now and then) as the load.
//
// A sender gives far more than the connections between can hold to a receiver that does not read, through a "hub" that
// pipes the two. Back-pressure holds when (1) the hub stops reading the sender (its reader pauses the sender's
// connection: Node's `pause` event, which the test waits for) while most of the load is still with the sender, and (2)
// no write of the hub's leaves more than about one batch in its own buffer for the slow side. Then the receiver reads,
// and every frame arrives, in order. A pipe of Effect's reader into its writer alone is the control: it never pauses
// the sender, and its buffer for the receiver grows to the whole load (the reason pipe.ts waits for a drain).

const CHUNK = 64 * 1024
/** 96 MiB: far beyond what the kernel's buffers on a loopback connection hold (a few MiB each way). */
const CHUNKS = 1536
const TOTAL = CHUNK * CHUNKS
/** The most a write may leave in the hub's buffer: a batch the reader pulled (its 64 KiB mark and a frame) and slack. */
const MOST_BUFFERED = 1024 * 1024

/** A terminal's output: frame `i` is `CHUNK` bytes of `i % 251`, with a text frame after every 100th. */
const sendLoad = (ws: NodeWS.WebSocket, chunks = CHUNKS) => {
  for (let i = 0; i < chunks; i++) {
    ws.send(new Uint8Array(CHUNK).fill(i % 251))
    if (i % 100 === 99) ws.send(`{"type":"ping","n":${i}}`)
  }
}

/** Receives the load and checks it as it comes: the binary bytes, once all of them have come in order. */
const receiveLoad = (ws: NodeWS.WebSocket) =>
  Effect.callback<number, string>((resume) => {
    let next = 0
    let bytes = 0
    ws.on("message", (data: Uint8Array, binary: boolean) => {
      if (!binary) {
        if (data.toString() !== `{"type":"ping","n":${next - 1}}`) resume(Effect.fail(`text frame out of order at ${next}`))
        return
      }
      if (data.byteLength !== CHUNK || data[0] !== next % 251 || data[CHUNK - 1] !== next % 251) resume(Effect.fail(`frame ${next} wrong`))
      next++
      bytes += data.byteLength
      if (next === CHUNKS) resume(Effect.succeed(bytes))
    })
  })

const opened = (ws: NodeWS.WebSocket) =>
  Effect.callback<void, string>((resume) => {
    if (ws.readyState === 1) return resume(Effect.void)
    ws.once("open", () => resume(Effect.void))
    ws.once("error", (e) => resume(Effect.fail(e.message)))
  })

/** A raw websocket server for the "host", and its first socket once it connects (paused if `paused`). */
const hostServer = (paused: boolean) =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<NodeWS.WebSocket>()
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeWS.WebSocketServer>((resume) => {
        const made = new NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" })
        made.once("listening", () => resume(Effect.succeed(made)))
      }),
      (made) =>
        Effect.sync(() => {
          for (const socket of made.clients) socket.terminate()
          made.close()
        }),
    )
    server.on("connection", (ws) => {
      if (paused) ws.pause()
      Deferred.doneUnsafe(connected, Effect.succeed(ws))
    })
    const address = server.address()
    return { url: `ws://127.0.0.1:${address !== null && typeof address === "object" ? address.port : 0}`, connected: Deferred.await(connected) }
  })

/** What the test sees of the hub: the bytes it wrote, the most a write left buffered, and the sender paused. */
interface Watch {
  readonly written: Ref.Ref<number>
  /** Written by the transport's view, which is plain code. */
  readonly mostBuffered: { current: number }
  readonly senderPaused: Deferred.Deferred<void>
  readonly allWritten: Deferred.Deferred<void>
}

const makeWatch = Effect.all(
  { written: Ref.make(0), mostBuffered: Effect.sync(() => ({ current: 0 })), senderPaused: Deferred.make<void>(), allWritten: Deferred.make<void>() },
  { concurrency: 1 },
)

/** `end` with each write's buffer measured: the pipe reads `writableNeedDrain` right after every write. */
const measured = (end: Pipeable, watch: Watch): Pipeable => ({
  socket: end.socket,
  transport: () => {
    const inner = end.transport()
    if (inner === undefined) return undefined
    watch.mostBuffered.current = Math.max(watch.mostBuffered.current, inner.writableLength)
    return inner
  },
})

const onPause = (watch: Watch) => (transport: Transport) => transport.once("pause", () => Deferred.doneUnsafe(watch.senderPaused, Effect.void))

const onWrite =
  (watch: Watch, all = TOTAL) =>
  (n: number) =>
    Effect.flatMap(
      Ref.updateAndGet(watch.written, (total) => total + n),
      (total) => (total >= all ? Deferred.succeed(watch.allWritten, undefined) : Effect.void),
    )

/** The control's load: 16 MiB, still more than the kernel's buffers hold, and holding it is slow. */
const CONTROL_CHUNKS = 256

/**
 * A hub on a free port whose `/relay` pipes the client's socket to the host's; the side that sends is `sender`, the
 * other is measured. `naive` pipes the host to the client with Effect's reader and writer alone.
 */
const hub = (hostUrl: string, sender: "client" | "host", watch: Watch, naive = false) =>
  HttpRouter.serve(
    HttpRouter.use((router) =>
      router.add(
        "GET",
        "/relay",
        Effect.gen(function* () {
          const client = yield* accept
          const clientTransport = client.transport()
          if (sender === "client" && clientTransport !== undefined) onPause(watch)(clientTransport)
          const host = yield* dial(hostUrl, sender === "host" ? { onOpen: onPause(watch) } : {})
          if (naive) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const reader = yield* host.socket.reader
                const writer = yield* client.socket.writer
                yield* (yield* client.socket.reader).pull.pipe(Effect.forkScoped)
                for (;;) {
                  const frames = yield* reader.pull
                  yield* writer.writeAll(frames)
                  measured(client, watch).transport()
                  yield* onWrite(watch, CONTROL_CHUNKS * CHUNK)(frames.reduce((n, f) => n + (typeof f === "string" ? 0 : f.byteLength), 0))
                }
              }),
            ).pipe(Effect.ignore)
          } else {
            yield* pipe(sender === "host" ? measured(client, watch) : client, sender === "client" ? measured(host, watch) : host, {
              onWrite: onWrite(watch),
            })
          }
          return HttpServerResponse.empty()
        }).pipe(Effect.orDie),
      ),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

/** Where the hub listens. */
const hubUrl = Effect.map(HttpServer.HttpServer, (server) => (server.address._tag === "UnixPathAddress" ? "" : `ws://127.0.0.1:${server.address.port}/relay`))

const client = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocket(url)),
    (ws) => Effect.sync(() => ws.terminate()),
  )

describe("two piped websockets (7.0)", () => {
  it.live(
    "a client that does not read stops the hub reading the host; then everything arrives, in order",
    () =>
      Effect.gen(function* () {
        const host = yield* hostServer(false)
        const watch = yield* makeWatch
        yield* Effect.gen(function* () {
          const ws = yield* client(yield* hubUrl)
          yield* opened(ws)
          ws.pause()
          const hostSide = yield* host.connected
          sendLoad(hostSide)
          yield* Deferred.await(watch.senderPaused)
          assert.isBelow(yield* Ref.get(watch.written), TOTAL / 2, "the hub forwarded most of the load before the client read any")
          assert.isAbove(hostSide.bufferedAmount, TOTAL / 2, "the load left the host while nobody read it")
          const arrived = receiveLoad(ws)
          ws.resume()
          assert.strictEqual(yield* arrived, TOTAL)
          assert.isAtMost(watch.mostBuffered.current, MOST_BUFFERED)
        }).pipe(Effect.provide(hub(host.url, "host", watch)))
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live(
    "a host that does not read stops the hub reading the client; then everything arrives, in order",
    () =>
      Effect.gen(function* () {
        const host = yield* hostServer(true)
        const watch = yield* makeWatch
        yield* Effect.gen(function* () {
          const ws = yield* client(yield* hubUrl)
          yield* opened(ws)
          const hostSide = yield* host.connected
          sendLoad(ws)
          yield* Deferred.await(watch.senderPaused)
          assert.isBelow(yield* Ref.get(watch.written), TOTAL / 2)
          assert.isAbove(ws.bufferedAmount, TOTAL / 2)
          const arrived = receiveLoad(hostSide)
          hostSide.resume()
          assert.strictEqual(yield* arrived, TOTAL)
          assert.isAtMost(watch.mostBuffered.current, MOST_BUFFERED)
        }).pipe(Effect.provide(hub(host.url, "client", watch)))
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live(
    "the control: Effect's reader into its writer alone reads the whole load while the client reads nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* hostServer(false)
        const watch = yield* makeWatch
        yield* Effect.gen(function* () {
          const ws = yield* client(yield* hubUrl)
          yield* opened(ws)
          ws.pause()
          const hostSide = yield* host.connected
          sendLoad(hostSide, CONTROL_CHUNKS)
          // Every byte reaches the hub's writer, which keeps what the client has not read.
          yield* Deferred.await(watch.allWritten)
          assert.isAbove(watch.mostBuffered.current, (CONTROL_CHUNKS * CHUNK) / 2)
          assert.isFalse(yield* Deferred.isDone(watch.senderPaused))
          // The naive pipe does not end when the client goes: the host's going ends it, before the hub stops.
          ws.terminate()
          hostSide.terminate()
        }).pipe(Effect.provide(hub(host.url, "host", watch, true)))
      }).pipe(Effect.scoped),
    60_000,
  )
})
