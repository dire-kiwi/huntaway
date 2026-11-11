import { Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig, serveFlags } from "../platform/ServerConfig.ts"
import type { ServeArgs } from "../platform/ServerConfig.ts"
import { StartupError } from "../platform/StartupError.ts"
import { installFromCli, keptEnv } from "../update/Service.ts"
import { Systemd } from "../update/Systemd.ts"

// `huntaway install-service [serve flags…]` (docs/plan/06-server.md, The CLI): install a systemd user service that runs
// `huntaway serve` with those flags (and this environment's configuring HUNTAWAY_* variables), and start it, or
// restart it if it runs already. For a host that isn't running yet, such as an SSH host.

/** Whether a host answers on 127.0.0.1:`port`. */
const listening = (port: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return yield* http.get(`http://127.0.0.1:${port}/api/health`).pipe(
      Effect.timeout("2 seconds"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  })

const install = (args: ServeArgs) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(Systemd.layer, FetchHttpClient.layer).pipe(Layer.provideMerge(Proc.layer), Layer.provideMerge(ServerConfig.layerFrom(args))),
    )
    yield* installWith(args).pipe(Effect.provideContext(context))
  }).pipe(Effect.scoped)

const installWith = (args: ServeArgs) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
      return yield* new StartupError({ reason: "install-service needs the port the host is to listen on (--port N)" })
    }
    if (config.exe === null) return yield* new StartupError({ reason: "run install-service through bin/huntaway, which the unit starts" })
    // The flags as given, after the command's name.
    const given = process.argv.slice(process.argv.indexOf("install-service") + 1)
    const spec = {
      exe: config.exe,
      args: ["serve", ...given],
      env: keptEnv(config.huntawayEnv),
      shell: config.loginShell,
      port: args.port,
      cwd: config.cwd,
    }
    const http = yield* HttpClient.HttpClient
    const check = Effect.provideService(listening(args.port), HttpClient.HttpClient, http)
    return yield* installFromCli(spec, check, (line) => Console.log(line)).pipe(Effect.mapError((e) => new StartupError({ reason: e.reason })))
  })

export const installServiceCommand = Command.make("install-service", serveFlags, install).pipe(
  Command.withDescription("Run `huntaway serve [serve flags…]` as a systemd user service, started at boot"),
)
