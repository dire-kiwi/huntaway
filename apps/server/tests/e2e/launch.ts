import { Deferred, Effect, FileSystem, Layer, Path, Ref, Schema, Stream } from "effect"
import { Headers } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth } from "@huntaway/contracts"

const launcher = new URL("../../bin/huntaway", import.meta.url)

const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))

/**
 * A server started through the launcher on a free port with a fresh data folder, as a service manager or the desktop
 * app starts it, for the scope, with `env` added to its environment. It is stopped with SIGTERM when the scope closes, if the test has not stopped it.
 */
export const startServer = (args: ReadonlyArray<string> = [], env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-e2e-" })
    const bin = yield* path.fromFileUrl(launcher)
    const process = yield* spawner.spawn(
      ChildProcess.make(bin, ["serve", "--port", "0", "--host", "127.0.0.1", "--data-dir", dataDir, ...args], { env, extendEnv: true }),
    )
    // Its stdout carries the ready line; its log (stderr) is kept to show if it never gets there. Both are read to
    // their end, so neither pipe fills.
    const ready = yield* Deferred.make<string>()
    const log = yield* Ref.make("")
    yield* process.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => (line.startsWith("HUNTAWAY_READY ") ? Deferred.succeed(ready, line.slice("HUNTAWAY_READY ".length)) : Effect.void)),
      Effect.forkScoped,
    )
    yield* process.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(log, (all) => all + text)),
      Effect.forkScoped,
    )
    const line = yield* Effect.raceFirst(
      Deferred.await(ready),
      process.exitCode.pipe(Effect.andThen((code) => Ref.get(log).pipe(Effect.andThen((text) => Effect.die(`the server exited with ${code}:\n${text}`))))),
    )
    const { port, token } = yield* Schema.decodeEffect(ReadyLine)(line)
    return { port, token: token ?? "", dataDir, process, log: Ref.get(log) }
  })

/** The typed client's protocol over a websocket to `/api/rpc`, with the board token on every request. */
export const socketRpcClientLayer = (port: number, token: string) =>
  Layer.mergeAll(
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/api/rpc`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
    RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
  )
