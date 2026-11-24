import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeWS from "@effect/platform-node/NodeWS"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { createServer } from "node:http"
import { websocketOptions } from "../http/websocket.ts"
import { accept, dial, pipe, speaksRpc, SPLIT_AT, splitFrame } from "./pipe.ts"
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
//
// The hub and the host listen with the server's own websocket options (permessage-deflate, HE-71) and the load doesn't
// compress, as a terminal's or a browser's stream mostly doesn't: a frame `ws` queues for deflate isn't in the
// connection's buffer, so a pipe that let its sockets negotiate deflate would read a sender faster than zlib into that
// queue. Both of the hub's sockets are uncompressed, though the client and the host offer deflate.

const CHUNK = 64 * 1024
/** 96 MiB: far beyond what the kernel's buffers on a loopback connection hold (a few MiB each way). */
const CHUNKS = 1536
const TOTAL = CHUNK * CHUNKS
/** The most a write may leave in the hub's buffer: a batch the reader pulled (its 64 KiB mark and a frame) and slack. */
const MOST_BUFFERED = 1024 * 1024

/** `CHUNK` bytes that don't deflate (xorshift32), the same in every frame but further apart than deflate's 32 KiB window. */
const NOISE = (() => {
  const bytes = new Uint8Array(CHUNK)
  let x = 2463534242
  for (let i = 0; i < CHUNK; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    bytes[i] = x & 0xff
  }
  return bytes
})()

/** Frame `i`: the noise, with its first and last bytes `i % 251`. */
const frame = (i: number) => {
  const bytes = NOISE.slice()
  bytes[0] = i % 251
  bytes[CHUNK - 1] = i % 251
  return bytes
}

/** A terminal's output: frame `i` of `CHUNK` bytes, with a text frame after every 100th. */
const sendLoad = (ws: NodeWS.WebSocket, chunks = CHUNKS) => {
  for (let i = 0; i < chunks; i++) {
    ws.send(frame(i))
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
      if (data.byteLength !== CHUNK || data[0] !== next % 251 || data[CHUNK - 1] !== next % 251 || data[CHUNK / 2] !== NOISE[CHUNK / 2])
        resume(Effect.fail(`frame ${next} wrong`))
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
        const made = new NodeWS.WebSocketServer({ ...websocketOptions, port: 0, host: "127.0.0.1" })
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
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1", websocket: websocketOptions })))

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
          assert.deepStrictEqual([ws.extensions, hostSide.extensions], ["", ""], "the hub's sockets are not compressed")
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
          assert.deepStrictEqual([ws.extensions, hostSide.extensions], ["", ""], "the hub's sockets are not compressed")
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
          assert.deepStrictEqual([ws.extensions, hostSide.extensions], ["", ""], "the hub's sockets are not compressed")
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

// HE-104: a listener takes a message of at most 16 MiB, and an RPC answer (a big board's snapshot) can be longer. A pipe
// told to split cuts an RPC socket's frames into parts its NDJSON joins again.
describe("a pipe that splits an RPC socket's frames (HE-104)", () => {
  it("cuts strings between surrogate pairs and bytes anywhere; NDJSON joins the parts", () => {
    const line = `${JSON.stringify({ text: "a😀".repeat(5) })}\n`
    const parts = splitFrame(line, 3)
    assert.isAbove(parts.length, 1)
    assert.strictEqual(parts.join(""), line)
    for (const part of parts) {
      assert.isString(part)
      if (typeof part === "string") assert.isFalse(/[\uD800-\uDBFF]$/.test(part), "a part never ends half way through a pair")
    }
    const parser = RpcSerialization.makeNdjson().makeUnsafe()
    assert.deepStrictEqual(parts.flatMap((part) => parser.decode(part)), [{ text: "a😀".repeat(5) }])
    const bytes = new TextEncoder().encode(line)
    const cut = splitFrame(bytes, 5)
    const byteParser = RpcSerialization.makeNdjson().makeUnsafe()
    assert.deepStrictEqual(cut.flatMap((part) => byteParser.decode(part)), [{ text: "a😀".repeat(5) }])
    assert.deepStrictEqual(splitFrame("short", 10), ["short"])
  })

  it.live(
    "a 20 MiB message reaches a listener that takes 16 MiB, in parts that join to it",
    () =>
      Effect.gen(function* () {
        // As an answer to a peer's request for a socket: this host's own RPC (`sender`), dialled, piped to the peer's
        // listener (`receiver`), dialled too.
        const sender = yield* hostServer(false)
        const receiver = yield* hostServer(false)
        const line = `${JSON.stringify({ snapshot: "x".repeat(20 * 1024 * 1024) })}\n`
        yield* pipe(yield* dial(sender.url), yield* dial(receiver.url), { split: SPLIT_AT }).pipe(Effect.forkScoped)
        const from = yield* sender.connected
        const to = yield* receiver.connected
        const joined = Effect.callback<string, string>((resume) => {
          let got = ""
          to.on("message", (data: Uint8Array) => {
            got += data.toString()
            if (got.length >= line.length) resume(Effect.succeed(got))
          })
          to.once("close", (code: number) => resume(Effect.fail(`closed with ${code}`)))
        })
        from.send(line)
        assert.strictEqual(yield* joined, line)
      }).pipe(Effect.scoped),
    60_000,
  )

  it("speaksRpc: the RPC and a relay's socket, not a terminal's or a browser's", () => {
    assert.deepStrictEqual(
      ["/api/rpc", `/api/relay/${"a".repeat(64)}`, "/api/terminal/t1", "/api/browser/b1"].map(speaksRpc),
      [true, true, false, false],
    )
  })
})
