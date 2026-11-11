import { Context, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { Unavailable } from "@huntaway/contracts"
import type { Conflict, ServiceStatus } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { JobFailed, Restarts } from "./Restarts.ts"
import { quoted, restartArgs, shQuote, Supervisor } from "./Supervisor.ts"
import { Systemd } from "./Systemd.ts"

// Running a host as a systemd user service (docs/plan/inventory/05-hosts-update.md, 2.6, 3.6 and section 9; the old
// service.ts). The unit runs `huntaway serve` with this server's flags and configuring variables, through the user's
// login shell (so agents get the PATH a terminal gives), with `KillMode=process`, so stopping or restarting the service
// leaves agents (under ia-shim) and terminals running. Lingering is turned on, so it starts at boot; a failure to turn
// it on is reported, not fatal. Not offered under the desktop app, which starts and stops its own server.

/** An install that could not be done: why. */
export class ServiceFailed extends Schema.TaggedError<ServiceFailed, { readonly brand: unique symbol }>()("ServiceFailed", { reason: Schema.String }) {}

/**
 * The unit for a host on `port`: `huntaway-<port>.service`, on every port. (The old server named its default port's
 * `huntaway.service`; this one never writes that name, so installing it cannot replace the old server's unit.)
 */
export const unitName = (port: number) => `huntaway-${port}.service`

/** Where user units go: `$XDG_CONFIG_HOME/systemd/user`. */
export const unitDir = (configHome: string) => `${configHome}/systemd/user`

/** The systemd service a process is in, from its `/proc/<pid>/cgroup`: the unit, and whether it is a user one. */
export const serviceOf = (cgroup: string): { readonly unit: string; readonly user: boolean } | null => {
  const lines = cgroup.split("\n")
  // cgroup v2's line is `0::/path`; v1 has a `name=systemd` hierarchy.
  const line = lines.find((l) => l.startsWith("0::")) ?? lines.find((l) => l.includes(":name=systemd:"))
  if (line === undefined) return null
  const path = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1)
  const last = path.split("/").pop() ?? ""
  if (!last.endsWith(".service")) return null
  return { unit: last, user: /\/user@\d+\.service\//.test(path) }
}

/** Variables a single start is given (by the launcher, the desktop app or a restart), which a unit leaves out. */
const ONCE = new Set([
  "HUNTAWAY_EXE",
  "HUNTAWAY_RESTART_FILE",
  "HUNTAWAY_SUPERVISOR_PID",
  "HUNTAWAY_SERVE_SIGNALS",
  "HUNTAWAY_MALLOC_MMAP",
  "HUNTAWAY_BUNDLED_SERVER",
  "HUNTAWAY_SKIP_DB_BACKUP_ONCE",
])

/** The `HUNTAWAY_*` variables a unit keeps: those that configure the server, not the desktop app's nor one start's. */
export const keptEnv = (env: ReadonlyArray<readonly [string, string]>): ReadonlyArray<readonly [string, string]> =>
  env.filter(([k]) => k.startsWith("HUNTAWAY_") && !ONCE.has(k) && !k.startsWith("HUNTAWAY_DESKTOP_")).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** What a unit runs: `exe` with `args` (`serve …`), `env` on top of the user manager's, through `shell`, in `cwd`. */
export interface Spec {
  readonly exe: string
  readonly args: ReadonlyArray<string>
  readonly env: ReadonlyArray<readonly [string, string]>
  readonly shell: string
  readonly port: number
  /** The folder relative paths in its flags (`--data-dir board`) are from. */
  readonly cwd: string
}

/** `args` without `--port N` (or `--port=N`), and with `--port <port>` at the end: the port the unit is named for. */
export const withPort = (args: ReadonlyArray<string>, port: number): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""
    if (a === "--port") i++
    else if (!a.startsWith("--port=")) out.push(a)
  }
  return [...out, "--port", String(port)]
}

/**
 * The spec that runs this server again: the release it was installed as (`HUNTAWAY_BUNDLED_SERVER`, which starts the
 * newest release again at startup), not one it updated to; its flags, with `serve` named (`huntaway --port N` isn't a
 * command); on the port it has.
 */
export const thisServer = (config: ServerConfig["Service"], exe: string, port: number): Spec => {
  const args = restartArgs(config.args)
  return {
    exe: config.bundledServer ?? exe,
    args: withPort(args[0] === "serve" ? args : ["serve", ...args], port),
    env: keptEnv(config.huntawayEnv),
    shell: config.loginShell,
    port,
    cwd: config.cwd,
  }
}

/** A double-quoted word for a unit file: C escapes for `\` and `"`, `%` (specifiers) doubled, and `$` too where `dollar`. */
const unitQuote = (s: string, dollar: boolean) => {
  const q = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
  return `"${dollar ? q.replaceAll("$", () => "$$") : q}"`
}

/** The unit file for `spec`, or why it can't be written (a newline or NUL in a value). */
export const unitText = (spec: Spec): { readonly text: string } | { readonly refused: string } => {
  const bad = [spec.exe, spec.shell, spec.cwd, ...spec.args, ...spec.env.flat()].find((s) => /[\n\r\0]/.test(s))
  if (bad !== undefined) return { refused: `${quoted(bad)} can't go in a unit file` }
  const command = `exec ${[spec.exe, ...spec.args].map(shQuote).join(" ")}`
  return {
    text: [
      "# Written by Huntaway (a host's page in Settings → Hosts, or `huntaway install-service`).",
      "[Unit]",
      `Description=Huntaway host on port ${spec.port}`,
      "",
      "[Service]",
      ...spec.env.map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`, false)}`),
      // systemd starts user units in the home folder. A path as it is (systemd doesn't unquote this one), with only
      // specifiers escaped; `-`: a folder that's gone doesn't stop the unit.
      `WorkingDirectory=-${spec.cwd.replaceAll("%", "%%")}`,
      // Through the login shell, so agents get the PATH they'd get from a terminal.
      `ExecStart=${unitQuote(spec.shell, true)} -lc ${unitQuote(command, true)}`,
      "Restart=on-failure",
      "RestartSec=5",
      // Agents run under ia-shim, and terminals in tmux: a stop or restart of the service leaves them running.
      "KillMode=process",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  }
}

const UNAVAILABLE = "this machine doesn't run systemd, so it can't run the host as a user service"

/** Whether this host can run as a user service: systemd, and not the desktop app's server. */
const available = Effect.gen(function* () {
  const config = yield* ServerConfig
  const systemd = yield* Systemd
  return config.desktopVersion === null && (yield* systemd.booted)
})

/** The service status of a host on `port`, where `available`. */
export const statusOf = (port: number) =>
  Effect.gen(function* () {
    if (!(yield* available)) return null
    const config = yield* ServerConfig
    const systemd = yield* Systemd
    const fs = yield* FileSystem.FileSystem
    const unit = unitName(port)
    const dir = unitDir(config.configHome)
    const own = serviceOf((yield* systemd.cgroup) ?? "")
    const running = own !== null && own.user && own.unit === unit
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
    return {
      unit,
      path: `${dir}/${unit}`,
      installed: yield* exists(`${dir}/${unit}`),
      enabled: yield* exists(`${dir}/default.target.wants/${unit}`),
      running,
      other: own === null || running ? null : own.user ? own.unit : `${own.unit} (system)`,
      linger: yield* systemd.lingering(config.user),
      user: config.user,
    } satisfies ServiceStatus
  })

/**
 * Write the unit for `spec` (0600: its environment may hold tokens), turn lingering on and enable it; `say` hears
 * what's done. It doesn't start it.
 */
export const install = (spec: Spec, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    if (!(yield* available)) return yield* new ServiceFailed({ reason: UNAVAILABLE })
    const config = yield* ServerConfig
    const systemd = yield* Systemd
    const fs = yield* FileSystem.FileSystem
    const unit = unitName(spec.port)
    const dir = unitDir(config.configHome)
    const path = `${dir}/${unit}`
    const text = unitText(spec)
    if ("refused" in text) return yield* new ServiceFailed({ reason: text.refused })
    const tmp = `${path}.${process.pid}.tmp`
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(tmp, text.text, { mode: 0o600 })),
      Effect.andThen(fs.chmod(tmp, 0o600)),
      Effect.andThen(fs.rename(tmp, path)),
      Effect.tapError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((e) => new ServiceFailed({ reason: `writing ${path}: ${e.message}` })),
    )
    yield* say(`wrote ${path}`)
    if (!(yield* systemd.lingering(config.user))) {
      const o = yield* systemd.loginctl(["enable-linger"])
      yield* say(
        o.success
          ? `turned lingering on for ${config.user}, so the service starts at boot`
          : `couldn't turn lingering on (${o.out}), so the service starts when ${config.user} logs in; \`sudo loginctl enable-linger ${config.user}\` starts it at boot`,
      )
    }
    const user = (args: ReadonlyArray<string>) =>
      systemd
        .systemctl(args)
        .pipe(
          Effect.flatMap((o) =>
            o.success
              ? Effect.void
              : Effect.fail(new ServiceFailed({ reason: `systemctl --user ${args.join(" ")} failed${o.out === "" ? "" : `: ${o.out}`}` })),
          ),
        )
    // Lingering starts the user manager, if it wasn't running: give it a few seconds.
    yield* user(["daemon-reload"]).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }))
    yield* user(["enable", unit])
    yield* say(`enabled ${unit}`)
    const status = yield* statusOf(spec.port)
    return status ?? (yield* new ServiceFailed({ reason: UNAVAILABLE }))
  })

/**
 * `huntaway install-service [serve flags…]`: install a user service that runs `huntaway serve` with those flags, and
 * start it, or restart it if it runs already. A host running on the port some other way is left alone.
 */
export const installFromCli = (spec: Spec, listening: Effect.Effect<boolean>, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const systemd = yield* Systemd
    const status = yield* install(spec, say)
    const start = (verb: "start" | "restart") =>
      systemd
        .systemctl([verb, status.unit])
        .pipe(
          Effect.flatMap((o) =>
            o.success
              ? say(`${verb}ed ${status.unit}`)
              : Effect.fail(new ServiceFailed({ reason: `systemctl --user ${verb} ${status.unit} failed: ${o.out}` })),
          ),
        )
    if ((yield* systemd.systemctl(["is-active", status.unit])).success) yield* start("restart")
    else if (yield* listening) {
      return yield* say(
        `A host is running on port ${spec.port} already, so ${status.unit} isn't started: stop that one, then run \`systemctl --user start ${status.unit}\`.`,
      )
    } else yield* start("start")
    return yield* say(`Its log: journalctl --user -u ${status.unit}`)
  })

export interface ServiceShape {
  /** `admin.status`'s `service`, for this server's port; null where user services can't run (or on a port picked at random). */
  readonly status: Effect.Effect<ServiceStatus | null>
  /**
   * Install this server's unit and hand over to it, as a restart job: once this server (and its launcher, whose process
   * it is) has stopped, the service starts it again with the same flags. Agents keep running.
   */
  readonly installAndSwitch: Effect.Effect<void, Unavailable | Conflict>
}

export class Service extends Context.Service<Service, ServiceShape>()("huntaway-server/update/Service") {
  static readonly layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const context = yield* Effect.context<ServerConfig | Systemd | FileSystem.FileSystem>()
      const config = yield* ServerConfig
      const restarts = yield* Restarts
      const supervisor = yield* Supervisor
      const systemd = yield* Systemd
      const port = config.port

      const installAndSwitch = Effect.gen(function* () {
        if (!(yield* available)) return yield* new Unavailable({ what: "service", reason: UNAVAILABLE })
        // As a restart does, this goes by the launcher's process, which is the server's.
        const pid = supervisor.pid
        if (pid === null || config.exe === null) {
          return yield* new Unavailable({ what: "service", reason: "this server wasn't started by bin/huntaway, so it can't hand over to a service" })
        }
        if (port === 0)
          return yield* new Unavailable({ what: "service", reason: "this server listens on a port picked at random: start it with --port N first" })
        const spec = thisServer(config, config.exe, port)
        return yield* restarts.begin(
          Effect.gen(function* () {
            const status = yield* install(spec, restarts.log).pipe(Effect.mapError((e) => new JobFailed({ reason: e.reason })))
            yield* restarts.phase("restarting")
            // Give the websocket a moment to deliver the last events.
            yield* Effect.sleep("300 millis")
            // Already that service: restart it, so it picks up the unit as written now.
            yield* systemd.handOver(status.unit, status.running ? "restart" : "start", pid)
          }).pipe(Effect.provideContext(context)),
        )
      }).pipe(Effect.provideContext(context))

      return Service.of({
        status: port === 0 ? Effect.succeed(null) : statusOf(port).pipe(Effect.provideContext(context)),
        installAndSwitch,
      })
    }),
  )
}
