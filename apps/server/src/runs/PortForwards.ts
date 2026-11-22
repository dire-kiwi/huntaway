import { Context, Deferred, Effect, FiberMap, Layer, Option, Ref, Schema, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import type { PortForward, TaskId } from "@huntaway/contracts"
import { WATCHDOG } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"

// HE-81: a task's dev server (`Task.servers`, see `DevServers`) shared with tailcat (https://tailscale.com/tailcat), so
// a client on another machine reaches it as its own localhost: the host runs `tailcat --json serve --key=new <port>`,
// which prints a new address, and the client runs `tailcat forward <address> <port>` (the desktop app does it itself).
// tailcat goes peer to peer over WireGuard where it can, through tailcat's DERP relays where it can't, with no
// Tailscale account and no change to the machine's network.
//
// One share per task and port, made when a client asks and kept while the task lists that server: asking again gives
// the same address. A new key each time, so an address stops working once its share ends. The address is a secret
// (whoever has it can connect), so it is never logged.

/** How long tailcat has to print its address. */
export const START_TIMEOUT = "30 seconds"
/** How often a share looks whether its server is still listed. */
export const CHECK_EVERY = "5 seconds"

/** What stays of tailcat's stderr, for the error when it doesn't start. */
const STDERR_KEPT = 2000

const unavailable = (reason: string) => new Unavailable({ what: "tailcat", reason })

const ListenJson = Schema.fromJsonString(Schema.Struct({ listenAddr: Schema.String }))

/** The address in a line of `tailcat --json serve`'s stdout (`{"listenAddr":"tc…"}`), or null. */
export const listenAddressOf = (line: string): string | null => {
  const parsed = Schema.decodeOption(ListenJson)(line.trim())
  return Option.isSome(parsed) && /^tc[A-Za-z0-9_-]+$/.test(parsed.value.listenAddr) ? parsed.value.listenAddr : null
}

/** Why tailcat didn't start, from its exit code and the end of its stderr. */
export const whyNotStarted = (code: number | null, stderr: string, bin: string): string => {
  if (code === 127) return `tailcat isn't installed on this host (looked for ${bin}): see https://tailscale.com/tailcat`
  const last =
    stderr
      .split("\n")
      .map((l) => l.replace(/^#\s*/, "").trim())
      .findLast((l) => l !== "") ?? ""
  return last === "" ? `tailcat stopped${code === null ? "" : ` with exit code ${code}`} before it printed an address` : `tailcat: ${last}`
}

export class PortForwards extends Context.Service<
  PortForwards,
  {
    /**
     * Share the task's server on `port` (one it lists) with tailcat, or give the share it has. Fails `NotFound` for a
     * port the task doesn't list, `Unavailable` when tailcat isn't there or doesn't start.
     */
    readonly forward: (task: TaskId, port: number) => Effect.Effect<PortForward, TaskNotFound | NotFound | Invalid | Unavailable>
  }
>()("huntaway-server/runs/PortForwards") {
  static readonly layer = Layer.effect(
    PortForwards,
    Effect.gen(function* () {
      const tasks = yield* TaskRepo
      const config = yield* ServerConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // The shares that printed their address, by `task:port`.
      const shared = yield* Ref.make<ReadonlyMap<string, PortForward>>(new Map())
      // Each share's tailcat, for as long as it lasts: stopped with the board.
      const shares = yield* FiberMap.make<string>()
      // One share starts at a time: two clicks don't start two.
      const starting = yield* Semaphore.make(1)

      const listed = (task: TaskId, port: number) => Effect.map(tasks.get(task), (row) => row !== null && row.servers.some((s) => s.port === port))

      /** tailcat's share of `port` until it stops or the task no longer lists the server; `ready` gets its address. */
      const share = (task: TaskId, port: number, key: string, ready: Deferred.Deferred<string, Unavailable>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner
              .spawn(
                ChildProcess.make("bash", ["-c", WATCHDOG, "huntaway-tailcat", config.tailcatBin, "--json", "serve", "--key=new", String(port)], {
                  detached: true,
                  env: config.agentEnv,
                  extendEnv: true,
                  stdin: { stream: Stream.never },
                }),
              )
              .pipe(Effect.mapError((e) => unavailable(`couldn't start tailcat: ${e.message}`)))
            const stderr = yield* Ref.make("")
            yield* Effect.forkScoped(
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runForEach((text) => Ref.update(stderr, (s) => (s + text).slice(-STDERR_KEPT))),
                Effect.ignore,
              ),
            )
            const address = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map(listenAddressOf),
              Stream.filter((a) => a !== null),
              Stream.runHead,
              Effect.orElseSucceed(() => Option.none<string>()),
            )
            if (Option.isNone(address)) {
              const code = yield* child.exitCode.pipe(
                Effect.map(Number),
                Effect.orElseSucceed(() => null),
              )
              return yield* unavailable(whyNotStarted(code, yield* Ref.get(stderr), config.tailcatBin))
            }
            yield* Ref.update(shared, (m) => new Map([...m, [key, { address: address.value, port }]]))
            yield* Deferred.succeed(ready, address.value)
            yield* Effect.logInfo(`task ${task}: sharing its server on port ${port} with tailcat`)
            const gone = Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(CHECK_EVERY)
                if (!(yield* listed(task, port))) return "its server is gone"
              }
            })
            const exited = child.exitCode.pipe(
              Effect.map((code) => `tailcat exited with ${code}`),
              Effect.orElseSucceed(() => "tailcat ended"),
            )
            const why = yield* Effect.raceFirst(gone, exited)
            return yield* Effect.logInfo(`task ${task}: no longer sharing port ${port}: ${why}`)
          }),
        ).pipe(
          Effect.tapError((e) => Deferred.fail(ready, e)),
          Effect.catchCause((cause) => Effect.logWarning(`task ${task}: sharing port ${port} with tailcat`, cause)),
          // A share that ended, or never started: the next ask starts another.
          Effect.ensuring(
            Effect.andThen(
              Ref.update(shared, (m) => new Map([...m].filter(([k]) => k !== key))),
              Deferred.fail(ready, unavailable("tailcat stopped")),
            ),
          ),
        )

      const forward = Effect.fn("PortForwards.forward")(function* (task: TaskId, port: number) {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return yield* new Invalid({ field: "port", reason: "bad port" })
        const row = yield* tasks.get(task)
        if (row === null) return yield* new TaskNotFound({ id: task })
        if (!row.servers.some((s) => s.port === port)) return yield* new NotFound({ what: "server", id: String(port) })
        const key = `${task}:${port}`
        return yield* Semaphore.withPermits(
          starting,
          1,
        )(
          Effect.gen(function* () {
            const have = (yield* Ref.get(shared)).get(key)
            if (have !== undefined) return have
            const ready = yield* Deferred.make<string, Unavailable>()
            yield* FiberMap.run(shares, key, share(task, port, key, ready))
            const address = yield* Deferred.await(ready).pipe(
              Effect.timeoutOrElse({
                duration: START_TIMEOUT,
                orElse: () => Effect.andThen(FiberMap.remove(shares, key), Effect.fail(unavailable("tailcat didn't print an address in time"))),
              }),
            )
            return { address, port }
          }),
        )
      })

      return PortForwards.of({ forward })
    }).pipe(Effect.annotateLogs({ module: "servers" })),
  )
}
