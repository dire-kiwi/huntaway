import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { createServer } from "node:http"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpServer } from "effect/http"
import { installServiceCommand } from "./cli/installService.ts"
// 6.7: the Google consent step for the assistant's Google server.
import { googleAuthCommand } from "./cli/googleAuth.ts"
import { rpcCommand } from "./cli/rpc.ts"
// 9.1: the importer of an old board.
import { importLegacyCommand } from "./cli/importLegacy.ts"
import { sshHostCommand } from "./cli/sshHost.ts"
import { Releases } from "./update/Releases.ts"
import { Supervisor } from "./update/Supervisor.ts"
// 6.9
import { telemetryCommand } from "./cli/telemetry.ts"
import { serverLayer } from "./Main.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Identity } from "./platform/Identity.ts"
import { Listening } from "./platform/Listening.ts"
import { InfoAndAbove, LoggingLive } from "./platform/Logging.ts"
import { releaseBuild, ServerConfig, serveArgs, serveFlags, VERSION } from "./platform/ServerConfig.ts"
import type { ServeFlags } from "./platform/ServerConfig.ts"
// 9.1: the guard over an imported folder, and the read-only server a rehearsal is served by.
import { ImportGuard } from "./platform/ImportGuard.ts"
import { readOnlyServerLayer } from "./ReadOnlyMain.ts"

// The entry point (docs/plan/06-server.md, The CLI): `huntaway [serve] [flags]`, `huntaway token [--hub]`,
// `huntaway --version`. The launcher (bin/huntaway) runs this file; the hooks have entry files of their own.

/** What the desktop shell and the test scripts read from stdout: `HUNTAWAY_READY {"port":…,"token":…}`. */
const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))

/** Shutdown waits this long for its finalizers, then the process exits regardless. */
const SHUTDOWN_FALLBACK = "2 seconds"

/** Shutdown's fallback: once the scope starts closing, the process exits within `SHUTDOWN_FALLBACK` regardless. */
const exitFallback = Effect.addFinalizer(() =>
  Effect.sleep(SHUTDOWN_FALLBACK).pipe(Effect.andThen(Effect.sync(() => process.exit(0))), Effect.forkDetach, Effect.asVoid),
)

/** What the desktop shell and the test scripts read, once the server listens: `HUNTAWAY_READY {"port":…,"token":…}`. */
const ready = (port: number, identity: Identity["Service"]) =>
  Effect.flatMap(Schema.encodeEffect(ReadyLine)({ port, token: identity.tokenGiven ? null : Redacted.value(identity.token) }), (line) =>
    Console.log(`HUNTAWAY_READY ${line}`),
  )

/**
 * Startup step 1 (docs/plan/06-server.md, Startup): `ImportGuard`, before the identity and the database are built. A
 * rehearsal folder is served read-only, and a switch's refuses to start while the old server has its database open.
 */
const serve = (flags: ServeFlags) =>
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
  const context = yield* Layer.build(serverLayer(config))
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

const serveCommand = Command.make("serve", serveFlags, serve).pipe(Command.withDescription("Run the board's server (the default)"))

const tokenCommand = Command.make(
  "token",
  { dataDir: serveFlags.dataDir, hub: Flag.Boolean("hub").pipe(Flag.withDescription("Print the hub token instead"), Flag.withDefault(false)) },
  ({ dataDir, hub }) =>
    Effect.gen(function* () {
      const identity = yield* Identity
      yield* Console.log(Redacted.value(hub ? identity.hubToken : identity.token))
    }).pipe(
      Effect.provide(
        Layer.provideMerge(Identity.layer, DataDir.layer).pipe(
          Layer.provide(Mac.layerWebCrypto),
          Layer.provide(SecureRandom.layerWebCrypto),
          Layer.provideMerge(
            ServerConfig.layerFrom({
              host: "127.0.0.1",
              port: 0,
              dataDir,
              uiDir: Option.none(),
              name: Option.none(),
              token: Option.none(),
              demo: false,
              openToken: false,
              profiles: [],
              skipDbBackup: false,
            }),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription("Print the board token (or, with --hub, the hub token)"))

const huntaway = Command.make("huntaway", serveFlags, serve).pipe(
  Command.withDescription("Huntaway: a kanban board for orchestrating Claude Code and Codex agents"),
  Command.withSubcommands([
    serveCommand,
    tokenCommand,
    rpcCommand,
    importLegacyCommand,
    sshHostCommand,
    installServiceCommand,
    // 6.9
    telemetryCommand,
    // 6.7: Node's HTTP server on the loopback, for the browser's way back.
    googleAuthCommand((port) => NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })),
  ]),
)

const program =
  process.argv[2] === "--version"
    ? // The release smoke test depends on this exact form. A release's version is its build.json's (beside its launcher).
      releaseBuild(process.env["HUNTAWAY_EXE"] ?? null).pipe(Effect.flatMap((build) => Console.log(`huntaway ${build?.version ?? VERSION}`)))
    : Command.run(huntaway, { version: VERSION })

program.pipe(
  Effect.catchTag("StartupError", (e) => Console.error(`huntaway: ${e.reason}`).pipe(Effect.andThen(Effect.sync(() => process.exit(1))))),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      LoggingLive,
      InfoAndAbove,
      // 6.7: `google-auth`'s token request and PKCE.
      FetchHttpClient.layer,
      SecureRandom.layerWebCrypto,
      Digest.layerWebCrypto,
    ),
  ),
  NodeRuntime.runMain,
)
