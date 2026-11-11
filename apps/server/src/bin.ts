import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { SecureRandom } from "effect/crypto"
import { HttpServer } from "effect/http"
import { rpcCommand } from "./cli/rpc.ts"
import { serverLayer } from "./Main.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Identity } from "./platform/Identity.ts"
import { InfoAndAbove, LoggingLive } from "./platform/Logging.ts"
import { ServerConfig, serveFlags, VERSION } from "./platform/ServerConfig.ts"
import type { ServeArgs } from "./platform/ServerConfig.ts"

// The entry point (docs/plan/06-server.md, The CLI): `huntaway [serve] [flags]`, `huntaway token [--hub]`,
// `huntaway --version`. The launcher (bin/huntaway) runs this file; the hooks have entry files of their own.

/** What the desktop shell and the test scripts read from stdout: `HUNTAWAY_READY {"port":…,"token":…}`. */
const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))

/** Shutdown waits this long for its finalizers, then the process exits regardless. */
const SHUTDOWN_FALLBACK = "2 seconds"

const serve = (args: ServeArgs) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    yield* Effect.addFinalizer(() => Effect.sleep(SHUTDOWN_FALLBACK).pipe(Effect.andThen(Effect.sync(() => process.exit(0))), Effect.forkDetach, Effect.asVoid))
    const context = yield* Layer.build(serverLayer(config))
    const server = Context.get(context, HttpServer.HttpServer)
    const identity = Context.get(context, Identity)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    yield* Effect.logInfo(`listening on ${HttpServer.formatAddress(server.address)} (host ${identity.hostId}, data ${Context.get(context, DataDir).root})`)
    const line = yield* Schema.encodeEffect(ReadyLine)({ port, token: identity.tokenGiven ? null : Redacted.value(identity.token) })
    yield* Console.log(`HUNTAWAY_READY ${line}`)
    return yield* Effect.never
  }).pipe(Effect.scoped, Effect.provide(ServerConfig.layerFrom(args)))

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
  Command.withSubcommands([serveCommand, tokenCommand, rpcCommand]),
)

const program =
  process.argv[2] === "--version"
    ? // The release smoke test depends on this exact form.
      Console.log(`huntaway ${VERSION}`)
    : Command.run(huntaway, { version: VERSION })

program.pipe(
  Effect.catchTag("StartupError", (e) => Console.error(`huntaway: ${e.reason}`).pipe(Effect.andThen(Effect.sync(() => process.exit(1))))),
  Effect.provide(Layer.mergeAll(NodeServices.layer, LoggingLive, InfoAndAbove)),
  NodeRuntime.runMain,
)
