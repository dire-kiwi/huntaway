import { Config, Console, Context, Effect, FileSystem, Layer, Option, Path, Runtime, Schedule, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient } from "effect/rpc"
import { HostRpcGroup } from "@huntaway/contracts"
import { httpRpcClientLayer } from "./rpc.ts"

// `huntaway ssh-host [--port N] [--data-dir D]` (inventory 05 §2.2, §5, §9): the forced command an SSH target runs for
// the hub's key (`command="huntaway ssh-host" ssh-ed25519 …` in its authorized_keys). It prints one JSON line about
// the host running on `port` here: `{ info, port, started: false, token }`. With `SSH_ORIGINAL_COMMAND=link` (the hub
// adding the host) it does not wait for a host that is down; otherwise it waits up to 15 s, through a restart. It reads
// the board token from the data folder's `auth_token`, so a host run with `--token` cannot be linked this way.

/** How long it waits for a host that is down to come back. */
const WAIT = "15 seconds"

const Line = Schema.fromJsonString(
  Schema.Struct({
    info: Schema.Unknown,
    port: Schema.Int,
    started: Schema.Boolean,
    token: Schema.String,
  }),
)

/** Why it could not say: on stderr, and exit 1 (the hub shows ssh's stderr). */
class SshHostFailed extends Schema.TaggedError<SshHostFailed, { readonly brand: unique symbol }>()("SshHostFailed", { reason: Schema.String }) {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return 1
  }
}

const sshHost = Effect.fn("ssh-host")(function* (port: number, dataDirGiven: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.String("HOME").pipe(Config.withDefault("/"))
  const dataHome = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(`${home}/.local/share`))
  const fromEnv = yield* Config.String("HUNTAWAY_DATA_DIR").pipe(Config.option)
  const original = yield* Config.String("SSH_ORIGINAL_COMMAND").pipe(Config.withDefault(""))
  const dataDir = Option.getOrElse(
    Option.orElse(dataDirGiven, () => fromEnv),
    () => path.join(dataHome, "huntaway-effect"),
  )
  const base = `http://127.0.0.1:${port}`
  const http = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
  const healthy = http.execute(HttpClientRequest.get(`${base}/api/health`)).pipe(
    Effect.timeout("3 seconds"),
    Effect.flatMap((r) => (r.status >= 200 && r.status < 300 ? Effect.void : Effect.fail("unhealthy"))),
  )
  const up = original === "link" ? healthy : healthy.pipe(Effect.retry({ schedule: Schedule.spaced("250 millis") }), Effect.timeout(WAIT))
  yield* up.pipe(
    Effect.mapError(
      () =>
        new SshHostFailed({
          reason: `no host is running on port ${port}: start one on this machine (\`huntaway install-service --host 127.0.0.1 --port ${port}\` runs it as a user service)`,
        }),
    ),
  )
  const token = yield* fs.readFileString(path.join(dataDir, "auth_token")).pipe(
    Effect.map((text) => text.trim()),
    Effect.mapError(() => new SshHostFailed({ reason: `no auth_token in ${dataDir}` })),
  )
  const info = yield* Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(base, token))
    const client = yield* RpcClient.make(HostRpcGroup, { flatten: true }).pipe(Effect.provideContext(context))
    return yield* client("host.info", undefined)
  }).pipe(
    Effect.scoped,
    Effect.mapError(() => new SshHostFailed({ reason: `the host on port ${port} didn't accept the token in ${dataDir}` })),
  )
  yield* Console.log(yield* Schema.encodeEffect(Line)({ info, port, started: false, token }).pipe(Effect.orDie))
})

export const sshHostCommand = Command.make(
  "ssh-host",
  {
    port: Flag.Int("port").pipe(Flag.withDescription("The port the host listens on here"), Flag.withDefault(7879)),
    dataDir: Flag.String("data-dir").pipe(Flag.withDescription("Its data folder (default ~/.local/share/huntaway-effect)"), Flag.optional),
  },
  ({ port, dataDir }) =>
    sshHost(port, dataDir).pipe(
      Effect.scoped,
      Effect.tapError((e) => Console.error(`huntaway ssh-host: ${e._tag === "SshHostFailed" ? e.reason : e.message}`)),
    ),
).pipe(Command.withDescription("The forced command for a hub's SSH key: print this machine's host and its token"))
