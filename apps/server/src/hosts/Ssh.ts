import { NodeSocketServer } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Option, Path, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { HostId, Invalid, Unavailable } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Identity } from "../platform/Identity.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { SshTarget } from "./LinkRepo.ts"
import type { Scope } from "effect"

// Hosts linked over SSH (docs/plan/08-hosts.md; inventory 05 §2.2, §5, §9): the hub's own key (`ssh/id_ed25519`, made
// on first use), host keys trusted on first use (`ssh/known_hosts`), the target's forced command (`huntaway ssh-host`,
// which prints its host's details and token), and a tunnel from a free local port to the host's port there. The
// argument list is the specification. A target never starts with `-` (`-oProxyCommand=…`), checked on input and again
// here. Every ssh process runs under a watchdog in its own process group that kills the group when the pipe only this
// server holds closes, so a tunnel dies with the server however it ends.

/** What `huntaway ssh-host` prints: the host's info, the port it listens on, and its board token. */
export const SshHostDetails = Schema.Struct({
  info: Schema.Struct({ host_id: HostId, host_name: Schema.String }),
  port: Schema.Int,
  started: Schema.NullOr(Schema.Boolean),
  token: Schema.String,
})
export interface SshHostDetails extends Schema.Schema.Type<typeof SshHostDetails> {}

const DetailsJson = Schema.fromJsonString(SshHostDetails)

/** Runs `ssh "$@"` with its stdin taken from the server's pipe: when that closes (the server is gone), the group dies. */
const WATCHDOG = `exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@"`

/** `user@host`, checked as the old `Target_from_json` and `add_ssh_host` did. */
export const checkTarget = (given: string): string | Invalid => {
  const target = given.trim()
  if (target.startsWith("-")) return new Invalid({ field: "target", reason: "a user@host can't start with -" })
  if (!target.includes("@")) return new Invalid({ field: "target", reason: "enter the target as user@host" })
  if (/\s/.test(target)) return new Invalid({ field: "target", reason: "a user@host has no spaces" })
  return target
}

/** `ssh`'s arguments to reach `t` with the hub's key in `dir`, then `more` (pure: the specification). */
export const sshArgs = (dir: string, t: SshTarget, more: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (t.target.trim().startsWith("-")) throw new Error(`the ssh target ${t.target} starts with -`)
  return [
    "-i",
    `${dir}/id_ed25519`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    `UserKnownHostsFile=${dir}/known_hosts`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(t.ssh_port),
    t.target,
    ...more,
  ]
}

const unavailable = (reason: string) => new Unavailable({ what: "ssh", reason })

/** A process's output, whole (none if it could not be read). */
const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
    Effect.orElseSucceed(() => ""),
  )

/** The last line of `stdout` that looks like JSON. */
const lastJsonLine = (stdout: string) =>
  stdout
    .split("\n")
    .toReversed()
    .find((line) => line.trimStart().startsWith("{"))

export class Ssh extends Context.Service<
  Ssh,
  {
    /** The hub's public key line, made on first use. */
    readonly publicKey: Effect.Effect<string, Unavailable>
    /** Runs the target's forced command (`link` while adding: it does not wait for a host that is down). */
    readonly details: (t: SshTarget, adding: boolean) => Effect.Effect<SshHostDetails, Unavailable>
    /**
     * A tunnel from a free port on 127.0.0.1 to `port` on the target, for the scope: the local port once it takes
     * connections, and an effect that ends when ssh does (with why).
     */
    readonly tunnel: (t: SshTarget, port: number) => Effect.Effect<{ readonly port: number; readonly exited: Effect.Effect<string> }, Unavailable, Scope.Scope>
  }
>()("huntaway-server/hosts/Ssh") {
  static readonly layer = Layer.effect(
    Ssh,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* DataDir
      const identity = yield* Identity
      const config = yield* ServerConfig
      const proc = yield* Proc
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const http = yield* HttpClient.HttpClient
      const dir = path.join(dataDir.root, "ssh")
      const key = path.join(dir, "id_ed25519")

      const publicKey = Effect.gen(function* () {
        if (!(yield* fs.exists(key).pipe(Effect.orElseSucceed(() => false)))) {
          yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => unavailable(e.message)))
          const made = yield* proc
            .run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `huntaway-hub@${identity.hostName}`, "-f", key])
            .pipe(Effect.mapError(() => unavailable("ssh-keygen not found (the hub needs openssh-client)")))
          if (made.code !== 0) return yield* unavailable(`ssh-keygen failed: ${made.stderr.trim()}`)
        }
        return (yield* fs.readFileString(`${key}.pub`).pipe(Effect.mapError((e) => unavailable(e.message)))).trim()
      })

      /** `ssh` with `args` under the watchdog, for the scope. */
      const spawn = (args: ReadonlyArray<string>) =>
        spawner
          .spawn(
            ChildProcess.make("bash", ["-c", WATCHDOG, "huntaway-ssh", config.sshBin, ...args], {
              detached: true,
              env: config.agentEnv,
              extendEnv: true,
              stdin: { stream: Stream.never },
            }),
          )
          .pipe(Effect.mapError((e) => unavailable(`couldn't start ssh: ${e.message}`)))

      const details = Effect.fn("Ssh.details")(function* (t: SshTarget, adding: boolean) {
        yield* publicKey
        const out = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawn(sshArgs(dir, t, [adding ? "link" : "ensure"]))
            const [stdout, stderr, code] = yield* Effect.all([text(child.stdout), text(child.stderr), Effect.orElseSucceed(child.exitCode, () => -1)], {
              concurrency: 3,
            })
            return { stdout, stderr, code: Number(code) }
          }),
        ).pipe(Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(unavailable(`ssh ${t.target} took too long`)) }))
        const line = lastJsonLine(out.stdout)
        if (out.code === 0 && line !== undefined) {
          const parsed = Schema.decodeOption(DetailsJson)(line)
          if (Option.isSome(parsed)) return parsed.value
        }
        const err = out.stderr.trim()
        if (err.includes("Permission denied"))
          return yield* unavailable(`${t.target} refused the hub's key; add the authorized_keys line shown in Settings → Hosts`)
        return yield* unavailable(`ssh ${t.target} failed: ${err || out.stdout.trim() || `exit ${out.code}`}`)
      })

      /** A port on 127.0.0.1 that nothing listens on now. */
      const freePort = Effect.scoped(
        Effect.gen(function* () {
          const server = yield* NodeSocketServer.make({ port: 0, host: "127.0.0.1" })
          return server.address._tag === "UnixPathAddress" ? 0 : server.address.port
        }),
      ).pipe(Effect.mapError((e) => unavailable(`no free port: ${e.message}`)))

      const tunnel = Effect.fn("Ssh.tunnel")(function* (t: SshTarget, port: number) {
        const local = yield* freePort
        const child = yield* spawn(sshArgs(dir, t, ["-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`]))
        const exited = child.exitCode.pipe(
          Effect.map((code) => `ssh exited with ${code}`),
          Effect.orElseSucceed(() => "ssh ended"),
        )
        // Up when the host answers through it (100 tries, 100 ms apart), or ssh gave up.
        const up = http.execute(HttpClientRequest.get(`http://127.0.0.1:${local}/api/health`)).pipe(
          Effect.timeout("2 seconds"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          Effect.mapError(() => unavailable(`the tunnel to ${t.target} didn't come up`)),
        )
        yield* Effect.raceFirst(
          up,
          Effect.flatMap(exited, (why) => Effect.fail(unavailable(why))),
        )
        return { port: local, exited }
      })

      return Ssh.of({ publicKey, details, tunnel })
    }),
  )
}
