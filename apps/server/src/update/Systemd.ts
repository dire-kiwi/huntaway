import { Context, Effect, FileSystem, Layer, Option } from "effect"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"

// Everything the service install asks of the machine (docs/plan/inventory/05-hosts-update.md, section 5): systemctl and
// loginctl for the user, whether systemd booted it, this process's cgroup, lingering, and the hand-over that outlives
// this server. Tests replace it (`layerTest`): no test runs systemctl or touches the machine's units.

/** What a `systemctl`/`loginctl` call came to: whether it succeeded, and what it said (stderr, else stdout). */
export interface CtlResult {
  readonly success: boolean
  readonly out: string
}

export interface SystemdShape {
  /** This machine runs systemd (Linux booted with it: `/run/systemd/system`). */
  readonly booted: Effect.Effect<boolean>
  /** `systemctl --user <args>`. */
  readonly systemctl: (args: ReadonlyArray<string>) => Effect.Effect<CtlResult>
  /** `loginctl <args>`. */
  readonly loginctl: (args: ReadonlyArray<string>) => Effect.Effect<CtlResult>
  /** This process's `/proc/self/cgroup`, if it can be read. */
  readonly cgroup: Effect.Effect<string | null>
  /** Lingering is on for `user` (`/var/lib/systemd/linger/<user>`). */
  readonly lingering: (user: string) => Effect.Effect<boolean>
  /**
   * Hand over to `unit`, in a process that outlives this server: `restart` it now (this server is that service), or
   * `start` it once the process `pid` (the launcher's, which is the server's) has gone, after stopping that process.
   */
  readonly handOver: (unit: string, how: "start" | "restart", pid: number) => Effect.Effect<void>
}

/** systemd, as this machine has it. */
export class Systemd extends Context.Service<Systemd, SystemdShape>()("huntaway-server/update/Systemd") {
  static readonly layer = Layer.effect(
    Systemd,
    Effect.gen(function* () {
      const proc = yield* Proc
      const fs = yield* FileSystem.FileSystem
      const config = yield* ServerConfig
      // A server started outside a login session may lack the user manager's runtime folder.
      const env: Record<string, string> = config.runtimeDir === null ? {} : { XDG_RUNTIME_DIR: config.runtimeDir }
      const ctl = (program: string, args: ReadonlyArray<string>) =>
        proc.run(program, args, { env, timeout: "30 seconds" }).pipe(
          Effect.map((r) => ({ success: r.code === 0, out: (r.stderr.trim() || r.stdout.trim()).slice(0, 2000) })),
          Effect.catch((e) => Effect.succeed({ success: false, out: e.reason })),
        )
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      // Detached (its own session), so it outlives this server and its launcher.
      const detached = (script: string, args: ReadonlyArray<string>) =>
        proc.run("sh", ["-c", `setsid sh -c "$0" "$@" </dev/null >/dev/null 2>&1 &`, script, ...args], { env }).pipe(Effect.ignore)
      return Systemd.of({
        booted: process.platform === "linux" ? exists("/run/systemd/system") : Effect.succeed(false),
        systemctl: (args) => ctl("systemctl", ["--user", ...args]),
        loginctl: (args) => ctl("loginctl", args),
        cgroup: fs.readFileString("/proc/self/cgroup").pipe(Effect.option, Effect.map(Option.getOrNull)),
        lingering: (user) => exists(`/var/lib/systemd/linger/${user}`),
        handOver: (unit, how, pid) =>
          how === "restart"
            ? // systemd stops this server itself; with KillMode=process only its main process.
              detached(`exec systemctl --user restart "$1"`, [unit])
            : // Up to 30 s for the server to go (and free its port), then start the service.
              detached(`i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done; exec systemctl --user start "$2"`, [
                String(pid),
                unit,
              ]).pipe(Effect.andThen(Effect.sync(() => process.kill(pid, "SIGTERM")))),
      })
    }),
  )

  /** For tests: a machine that answers as `options` say, and tells `options.called` of every command. */
  static readonly layerTest = (options: {
    readonly booted: boolean
    readonly cgroup?: string | null
    readonly lingering?: boolean
    /** The answer to `program args`; success with no output by default. */
    readonly answer?: (program: "systemctl" | "loginctl", args: ReadonlyArray<string>) => CtlResult
    readonly called?: (line: string) => void
  }) =>
    Layer.succeed(
      Systemd,
      Systemd.of({
        booted: Effect.succeed(options.booted),
        systemctl: (args) =>
          Effect.sync(() => {
            options.called?.(`systemctl --user ${args.join(" ")}`)
            return options.answer?.("systemctl", ["--user", ...args]) ?? { success: true, out: "" }
          }),
        loginctl: (args) =>
          Effect.sync(() => {
            options.called?.(`loginctl ${args.join(" ")}`)
            return options.answer?.("loginctl", args) ?? { success: true, out: "" }
          }),
        cgroup: Effect.succeed(options.cgroup ?? null),
        lingering: () => Effect.succeed(options.lingering ?? false),
        handOver: (unit, how, pid) => Effect.sync(() => options.called?.(`hand over: ${how} ${unit} after ${pid}`)),
      }),
    )
}
