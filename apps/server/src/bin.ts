import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Config, Console, Effect, Layer, Option, Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { CONSENT_PORT } from "./assistant/googleText.ts"
import { InfoAndAbove, LoggingLive } from "./platform/Logging.ts"
import { releaseBuild, ServerConfig, serveFlags, VERSION } from "./platform/ServerConfig.ts"
import type { ServeFlags } from "./platform/ServerConfig.ts"

// The entry point (docs/plan/06-server.md, The CLI): `huntaway [serve] [flags]`, `huntaway token [--hub]`,
// `huntaway --version` and the other subcommands. The launcher (bin/huntaway) runs it through entry.ts, which turns on
// Node's compile cache; the hooks and codex-run have entry files of their own.
//
// HE-71: this file has each command's flags and help, and loads what runs a command when it runs (`import()`), so that
// `huntaway --version`, `--help` or `rpc` doesn't load the whole server first: `serve` is serve.ts (which loads Main.ts),
// the others their cli/ modules.

/** `serve`, the default command: serve.ts, and the server behind it, are loaded only for it. */
const serve = (flags: ServeFlags) =>
  Effect.flatMap(
    Effect.promise(() => import("./serve.ts")),
    (m) => m.serve(flags),
  )

const serveCommand = Command.make("serve", serveFlags, serve).pipe(Command.withDescription("Run the board's server (the default)"))

const tokenCommand = Command.make(
  "token",
  { dataDir: serveFlags.dataDir, hub: Flag.Boolean("hub").pipe(Flag.withDescription("Print the hub token instead"), Flag.withDefault(false)) },
  ({ dataDir, hub }) =>
    Effect.gen(function* () {
      const [{ Identity }, { DataDir }] = yield* Effect.promise(() => Promise.all([import("./platform/Identity.ts"), import("./platform/DataDir.ts")]))
      const identity = yield* Effect.service(Identity).pipe(
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
      )
      yield* Console.log(Redacted.value(hub ? identity.hubToken : identity.token))
    }),
).pipe(Command.withDescription("Print the board token (or, with --hub, the hub token)"))

const rpcCommand = Command.make(
  "rpc",
  {
    method: Argument.String("method").pipe(Argument.withDescription("The method, as `huntaway rpc --list` names it (host.info)"), Argument.optional),
    json: Argument.String("json").pipe(Argument.withDescription("Its payload as JSON (default none, or {})"), Argument.optional),
    env: Flag.String("env").pipe(
      Flag.withDescription("scripts/test-server.sh's env file or data dir (default $HUNTAWAY_TEST_ENV, then .huntaway-test-env)"),
      Flag.optional,
    ),
    list: Flag.Boolean("list").pipe(Flag.withDescription("Print the method names"), Flag.withDefault(false)),
  },
  (args) =>
    Effect.flatMap(
      Effect.promise(() => import("./cli/rpc.ts")),
      (m) => m.rpc(args),
    ),
).pipe(
  Command.withDescription(
    "Call a test server's RPC over HTTP and print the result as JSON (exit 1 with the tagged error on stderr; 2 for a bad method or payload)",
  ),
)

// 9.1: the importer of an old board.
const importLegacyCommand = Command.make(
  "import-legacy",
  {
    from: Flag.String("from").pipe(Flag.withDescription("The old server's data folder (e.g. ~/.local/share/issue-agent); only read")),
    dataDir: serveFlags.dataDir,
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Check the import against the old database and exit 1 if the report has a failure; on a folder already imported, check it alone"),
      Flag.withDefault(false),
    ),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Record live runs as interrupted instead of refusing"), Flag.withDefault(false)),
    rehearsal: Flag.Boolean("rehearsal").pipe(
      Flag.withDescription("Beside a running old server: a board with no identity or credentials of the old host's, which only a read-only server opens"),
      Flag.withDefault(false),
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription(
        "The new folder has a board already, to be replaced: with its server stopped, set it aside under replaced-<time>/ in that folder and import in its place",
      ),
      Flag.withDefault(false),
    ),
    database: Flag.String("db").pipe(Flag.withDescription("Which old database file, when the old folder has more than one"), Flag.optional),
  },
  (args) =>
    Effect.flatMap(
      Effect.promise(() => import("./cli/importLegacy.ts")),
      (m) => m.importLegacyMain(args),
    ),
).pipe(Command.withDescription("Import an old Huntaway board's data folder into a new one (docs/guide/switching.md)"))

const sshHostCommand = Command.make(
  "ssh-host",
  {
    port: Flag.Int("port").pipe(Flag.withDescription("The port the host listens on here"), Flag.withDefault(7879)),
    dataDir: Flag.String("data-dir").pipe(Flag.withDescription("Its data folder (default ~/.local/share/huntaway-effect)"), Flag.optional),
  },
  (args) =>
    Effect.flatMap(
      Effect.promise(() => import("./cli/sshHost.ts")),
      (m) => m.sshHostMain(args),
    ),
).pipe(Command.withDescription("The forced command for a hub's SSH key: print this machine's host and its token"))

const installServiceCommand = Command.make("install-service", serveFlags, (flags) =>
  Effect.flatMap(
    Effect.promise(() => import("./cli/installService.ts")),
    (m) => m.install(flags),
  ),
).pipe(Command.withDescription("Run `huntaway serve [serve flags…]` as a systemd user service, started at boot"))

// 6.9
const telemetryUrl = Flag.String("url").pipe(
  Flag.withDescription("ClickHouse: http://USER[:PASSWORD]@HOST:8123[/DATABASE] (default $HUNTAWAY_TELEMETRY_URL)"),
  Flag.withFallbackConfig(Config.String("HUNTAWAY_TELEMETRY_URL")),
  Flag.optional,
)
const telemetry = Effect.promise(() => import("./cli/telemetry.ts"))
const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription("Set up and check the ClickHouse telemetry goes to (a password left out of --url is read from HUNTAWAY_TELEMETRY_PASSWORD)"),
  Command.withSubcommands([
    Command.make("init", { url: telemetryUrl }, ({ url }) => Effect.flatMap(telemetry, (m) => m.init(url))).pipe(
      Command.withDescription("Create the database (default huntaway) and its tables, or bring them up to date: give it a login that can, such as an admin's"),
    ),
    Command.make("test", { url: telemetryUrl }, ({ url }) => Effect.flatMap(telemetry, (m) => m.test(url))).pipe(
      Command.withDescription("Check that a login can insert into the tables, as a host's writer must"),
    ),
    Command.make(
      "backfill",
      {
        dataDir: Flag.String("data-dir").pipe(
          Flag.withDescription("The board's data folder (default $HUNTAWAY_DATA_DIR, else ~/.local/share/huntaway-effect)"),
          Flag.optional,
        ),
        url: telemetryUrl,
        dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Count what would be sent, and send nothing"), Flag.withDefault(false)),
      },
      ({ dataDir, url, dryRun }) => Effect.flatMap(telemetry, (m) => m.backfill(dataDir, url, dryRun)),
    ).pipe(Command.withDescription("Send this host's history from before telemetry was turned on, for the profiles that send")),
  ]),
)

// 6.7: the Google consent step for the assistant's Google server, with Node's HTTP server on the loopback for the
// browser's way back.
const googleAuthCommand = Command.make(
  "google-auth",
  {
    clientSecret: Flag.String("client-secret").pipe(
      Flag.withDescription("The OAuth client's JSON, downloaded from Google Cloud (a Desktop app client)"),
      Flag.optional,
    ),
    credentialsDir: Flag.String("credentials-dir").pipe(
      Flag.withDescription("Where to keep the credentials (workspace-mcp's WORKSPACE_MCP_CREDENTIALS_DIR)"),
      Flag.optional,
    ),
    port: Flag.Int("port").pipe(Flag.withDescription(`The port to listen on (default ${CONSENT_PORT})`), Flag.withDefault(CONSENT_PORT)),
  },
  (args) =>
    Effect.gen(function* () {
      const [{ googleAuth }, NodeHttpServer, { createServer }] = yield* Effect.promise(() =>
        Promise.all([import("./cli/googleAuth.ts"), import("@effect/platform-node/NodeHttpServer"), import("node:http")]),
      )
      return yield* googleAuth((port) => NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" }))(args)
    }),
).pipe(Command.withDescription("Sign in to Google for the assistant's Google server (Gmail, Calendar, Drive), on a headless host"))

const huntaway = Command.make("huntaway", serveFlags, serve).pipe(
  Command.withDescription("Huntaway: a kanban board for orchestrating Claude Code and Codex agents"),
  Command.withSubcommands([
    serveCommand,
    tokenCommand,
    rpcCommand,
    importLegacyCommand,
    sshHostCommand,
    installServiceCommand,
    telemetryCommand,
    googleAuthCommand,
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
