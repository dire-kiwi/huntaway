import { Console, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServer } from "effect/http"
import { flushCompileCache } from "node:module"
import { StartupStep } from "@huntaway/contracts"
import { DataDir } from "./platform/DataDir.ts"
import { Identity } from "./platform/Identity.ts"
import { ImportGuard } from "./platform/ImportGuard.ts"
import { Listening } from "./platform/Listening.ts"
import { ServerConfig, serveArgs } from "./platform/ServerConfig.ts"
import type { ServeFlags } from "./platform/ServerConfig.ts"
import { StartupProgress } from "./platform/StartupProgress.ts"

// `huntaway [serve] [flags]` (docs/plan/06-server.md, The CLI, Startup), which bin.ts loads when it runs `serve` (HE-71:
// the other subcommands don't load the server). The composition roots, `Main.ts` and the read-only `ReadOnlyMain.ts`,
// are loaded once `ImportGuard` has said which of them the folder is served by.

/** What the desktop shell and the test scripts read from stdout: `HUNTAWAY_READY {"port":…,"token":…}`. */
const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))
const StartupLine = Schema.fromJsonString(StartupStep)

/** Shutdown waits this long for its finalizers, then the process exits regardless. */
const SHUTDOWN_FALLBACK = "2 seconds"

/** Shutdown's fallback: once the scope starts closing, the process exits within `SHUTDOWN_FALLBACK` regardless. */
const exitFallback = Effect.addFinalizer(() =>
  Effect.sleep(SHUTDOWN_FALLBACK).pipe(Effect.andThen(Effect.sync(() => process.exit(0))), Effect.forkDetach, Effect.asVoid),
)

/**
 * What the desktop shell and the test scripts read, once the server listens: `HUNTAWAY_READY {"port":…,"token":…}`.
 * Then Node's compile cache is written (entry.ts), as a server seldom exits the way that has Node write it.
 */
const ready = (port: number, identity: Identity["Service"]) =>
  Effect.flatMap(Schema.encodeEffect(ReadyLine)({ port, token: identity.tokenGiven ? null : Redacted.value(identity.token) }), (line) =>
    Console.log(`HUNTAWAY_READY ${line}`),
  ).pipe(Effect.andThen(Effect.sync(() => flushCompileCache())))

/** How far the start has got, for the desktop app: `HUNTAWAY_PROGRESS {"step":…}` (contracts' `StartupStep`). */
const printProgress = (step: StartupStep) =>
  Schema.encodeEffect(StartupLine)(step).pipe(
    Effect.flatMap((line) => Console.log(`HUNTAWAY_PROGRESS ${line}`)),
    Effect.ignore,
  )

/**
 * Startup step 1 (docs/plan/06-server.md, Startup): `ImportGuard`, before the identity and the database are built. A
 * rehearsal folder is served read-only, and a switch's refuses to start while the old server has its database open.
 */
export const serve = (flags: ServeFlags) =>
  Effect.gen(function* () {
    // The configuration is read once: it takes the launcher's restart file out of the environment as it does.
    const config = yield* ServerConfig
    const guard = yield* Effect.service(ImportGuard).pipe(Effect.provide(ImportGuard.layer))
    if (!guard.readOnly) return yield* serveBoard
    // A rehearsal listens on this machine only unless `--host` (or HUNTAWAY_HOST) says otherwise.
    return yield* serveReadOnly(guard).pipe(Effect.provideService(ServerConfig, Option.isSome(flags.host) ? config : { ...config, host: "127.0.0.1" }))
  }).pipe(Effect.provide(ServerConfig.layerFrom(serveArgs(flags))))

/** A rehearsal (`ReadOnlyMain`): it reads, starts nothing, changes nothing outside its folder, and calls nothing on the network. */
const serveReadOnly = (guard: ImportGuard["Service"]) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    yield* exitFallback
    const { readOnlyServerLayer } = yield* Effect.promise(() => import("./ReadOnlyMain.ts"))
    const context = yield* Layer.build(readOnlyServerLayer(config).pipe(Layer.provide(ImportGuard.layerOf(guard.record))))
    const server = Context.get(context, HttpServer.HttpServer)
    const identity = Context.get(context, Identity)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    yield* Context.get(context, Listening).bound(port)
    yield* Effect.logInfo(
      `read-only rehearsal of ${guard.record?.from ?? "an imported board"}: listening on ${HttpServer.formatAddress(server.address)} (host ${identity.hostId}, data ${Context.get(context, DataDir).root})`,
    )
    yield* ready(port, identity)
    return yield* Effect.never
  }).pipe(Effect.scoped)

const serveBoard = Effect.gen(function* () {
  const config = yield* ServerConfig
  yield* exitFallback
  const [{ serverLayer }, { Releases }, { Supervisor }] = yield* Effect.promise(() =>
    Promise.all([import("./Main.ts"), import("./update/Releases.ts"), import("./update/Supervisor.ts")]),
  )
  const context = yield* Layer.build(serverLayer(config)).pipe(Effect.provideService(StartupProgress, printProgress))
  const server = Context.get(context, HttpServer.HttpServer)
  const identity = Context.get(context, Identity)
  // Only now, listening with the hubs dialled and discovery answering, has a release come up: it becomes current (the
  // old server settled after listen, dial-out and discovery). One that fails before this stays `trying`, and the next
  // start marks it bad and goes back (Releases.execInstalled).
  yield* Context.get(context, Releases).settle
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
  // What runs are told to reach the server on: the port the listener got (`--port 0` asks for a free one).
  yield* Context.get(context, Listening).bound(port)
  yield* Effect.logInfo(`listening on ${HttpServer.formatAddress(server.address)} (host ${identity.hostId}, data ${Context.get(context, DataDir).root})`)
  yield* ready(port, identity)
  // From now on the launcher starts the server again if it crashes (step 6).
  yield* Context.get(context, Supervisor).started
  return yield* Effect.never
}).pipe(Effect.scoped)
