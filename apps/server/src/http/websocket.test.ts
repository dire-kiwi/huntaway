import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeWS from "@effect/platform-node/NodeWS"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { MAX_MESSAGE, websocketOptions } from "./websocket.ts"

// The listeners' websocket options (HE-71): a deflated message that would inflate past `MAX_MESSAGE` is refused with
// 1009 before it is inflated, from a socket nothing has authenticated; one under it arrives, deflated.

/** A listener with the server's options whose `/ws` reads its socket, and the size of the first message it got. */
const served = (received: Deferred.Deferred<number>) =>
  HttpRouter.serve(
    HttpRouter.use((router) =>
      router.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade
          const reader = yield* socket.reader
          const frames = yield* reader.pull
          yield* Deferred.succeed(
            received,
            frames.reduce((n, frame) => n + (typeof frame === "string" ? frame.length : frame.byteLength), 0),
          )
          return HttpServerResponse.empty()
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => HttpServerResponse.empty()),
        ),
      ),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1", websocket: websocketOptions })))

/** A client of `/ws` (which offers deflate, as browsers do), open, and the close code the server gives it. */
const client = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocket(`ws://127.0.0.1:${port}/ws`)),
    (made) => Effect.sync(() => made.terminate()),
  )
  const closed = Effect.callback<number>((resume) => {
    ws.once("close", (code) => resume(Effect.succeed(code)))
  })
  yield* Effect.callback<void, string>((resume) => {
    ws.once("open", () => resume(Effect.void))
    ws.once("error", (error) => resume(Effect.fail(error.message)))
  })
  return { ws, closed }
})

describe("the listeners' websocket options", () => {
  it.live("a deflated message that inflates past the limit is closed with 1009", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<number>()
      yield* Effect.gen(function* () {
        const { ws, closed } = yield* client
        assert.strictEqual(ws.extensions, "permessage-deflate")
        ws.send(new Uint8Array(MAX_MESSAGE + 1))
        assert.strictEqual(yield* closed, 1009)
        assert.isFalse(yield* Deferred.isDone(received))
      }).pipe(Effect.provide(served(received)))
    }).pipe(Effect.scoped),
  )

  it.live("a deflated message at the limit arrives", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<number>()
      yield* Effect.gen(function* () {
        const { ws } = yield* client
        ws.send(new Uint8Array(MAX_MESSAGE))
        assert.strictEqual(yield* Deferred.await(received), MAX_MESSAGE)
      }).pipe(Effect.provide(served(received)))
    }).pipe(Effect.scoped),
  )
})
