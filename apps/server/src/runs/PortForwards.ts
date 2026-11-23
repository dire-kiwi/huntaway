import { Context, DateTime, Deferred, Effect, Fiber, FiberMap, Layer, Option, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { Invalid, NotFound, TaskId, Timestamp, Unavailable } from "@huntaway/contracts"
import type { PortForward, TaskServer } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { Proc, WATCHDOG } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { sharedSince } from "./devServers/proc.ts"

// HE-81: a task's dev server (`Task.servers`, see `DevServers`) shared with tailcat (https://tailscale.com/tailcat), so
// a client on another machine reaches it as its own localhost: the host runs `tailcat --json serve --key=new <port>`,
// which prints a new address, and the client runs `tailcat forward <address> <port>` (the desktop app does it itself).
// tailcat goes peer to peer over WireGuard where it can, through tailcat's DERP relays where it can't, with no
// Tailscale account and no change to the machine's network.
//
// One share per task and port, made when a client asks and kept while the task lists that server: asking again gives
// the same address. A new key each time, so an address stops working once its share ends. The address is a secret
// (whoever has it can connect), so it is never logged.
//
// HE-83: while a share lasts, the task's server says so (`TaskServer.forwarded`, when it started), written as it starts
// and cleared as it ends, and shown to every client as a task event; `reset` clears what a board that stopped left. Only
// that it's shared, not the address: a task goes to every client and agent that reads the board (`get_task`, other
// profiles' agents, the phone's cache), and the address is a key to the server, so it comes only from `forward`.

/** How long tailcat has to print its address. */
export const START_TIMEOUT = "30 seconds"
/** How often a share looks whether its server is still listed. */
export const CHECK_EVERY = "5 seconds"

/** How long `tailcat serve --help` and `tailcat version` have to answer. */
const ASK_TIMEOUT = "10 seconds"

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

/** Whether a server on `address` is reached as localhost: on loopback, or on every address. */
export const onLocalhost = (address: string): boolean => ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(address)

/**
 * What `tailcat serve` is given for a server on `port` that the task lists on `addresses`: the port, proxied to
 * localhost, when one is reached as localhost; else (HE-85) a mapping to the first, `port:address:port`, with an IPv6
 * address in brackets.
 */
export const serveTarget = (port: number, addresses: ReadonlyArray<string>): string => {
  const only = addresses.find((a) => !onLocalhost(a))
  if (only === undefined || addresses.some(onLocalhost)) return String(port)
  return `${port}:${only.includes(":") ? `[${only}]` : only}:${port}`
}

/** Whether `tailcat serve --help` tells of port mappings (`port:target`, after v0.7.0); v0.7.0's proxies to localhost only. */
export const hasMappings = (help: string): boolean => /\bport mappings?\b/i.test(help)

/** The server shown shared since `since`. */
const marked =
  (since: Timestamp) =>
  (s: TaskServer): TaskServer =>
    s.forwarded === since ? s : sharedSince(s, since)

/** The server shown not shared, if it was shown shared since `since` (any share, with none). */
const unmarked =
  (since?: Timestamp) =>
  (s: TaskServer): TaskServer =>
    s.forwarded === undefined || (since !== undefined && s.forwarded !== since) ? s : sharedSince(s, undefined)

/** Rewrites a task's servers on `port` (every port, for null) with `f`, and shows the task if that changed it. */
const rewriter = Effect.gen(function* () {
  const db = yield* Db
  const tasks = yield* TaskRepo
  const events = yield* Events
  return (task: TaskId, port: number | null, f: (s: TaskServer) => TaskServer) =>
    db.tx(
      Effect.gen(function* () {
        const row = yield* tasks.get(task)
        if (row === null) return
        const servers = row.servers.map((s) => (port === null || s.port === port ? f(s) : s))
        if (servers.every((s, i) => s === row.servers[i])) return
        yield* tasks.write(task, { servers }, Timestamp.make(DateTime.formatIso(yield* DateTime.now)))
        const after = yield* tasks.get(task)
        if (after !== null) yield* events.emit({ type: "task", task: after })
      }),
    )
})

export class PortForwards extends Context.Service<
  PortForwards,
  {
    /**
     * Share the task's server on `port` (one it lists) with tailcat, or give the share it has. Fails `NotFound` for a
     * port the task doesn't list, `Unavailable` when tailcat isn't there or doesn't start, or can't reach the server
     * (HE-85: one on another address than localhost, with a tailcat without port mappings).
     */
    readonly forward: (task: TaskId, port: number) => Effect.Effect<PortForward, TaskNotFound | NotFound | Invalid | Unavailable>
  }
>()("huntaway-server/runs/PortForwards") {
  static readonly layer = Layer.effect(
    PortForwards,
    Effect.gen(function* () {
      const tasks = yield* TaskRepo
      const config = yield* ServerConfig
      const shownAs = yield* rewriter
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const locks = yield* KeyedLock
      const proc = yield* Proc
      // The shares that printed their address, by `task:port`.
      const shared = yield* Ref.make<ReadonlyMap<string, PortForward>>(new Map())
      // Each share's tailcat, for as long as it lasts: stopped with the board.
      const shares = yield* FiberMap.make<string>()

      const listed = (task: TaskId, port: number) => Effect.map(tasks.get(task), (row) => row !== null && row.servers.some((s) => s.port === port))

      /** Runs `tailcat <args>` to its end and gives its stdout, or why it couldn't. */
      const ask = (args: ReadonlyArray<string>) =>
        proc.run(config.tailcatBin, args, { env: config.agentEnv, timeout: ASK_TIMEOUT }).pipe(
          Effect.mapError((e) =>
            unavailable(e.reason.startsWith("NotFound") ? whyNotStarted(127, "", config.tailcatBin) : `tailcat ${args.join(" ")}: ${e.reason}`),
          ),
          Effect.map((r) => r.stdout),
        )

      /**
       * The target `tailcat serve` can proxy to a server on `port` listed on `addresses` (HE-85). One that listens only
       * on another address needs a tailcat with port mappings: without, it fails `Unavailable`, as tailcat would proxy to
       * localhost, where nothing answers.
       */
      const targetOf = Effect.fn("PortForwards.targetOf")(function* (port: number, addresses: ReadonlyArray<string>) {
        const target = serveTarget(port, addresses)
        if (target === String(port) || hasMappings(yield* ask(["serve", "--help"]))) return target
        const version = (yield* ask(["version"]).pipe(Effect.orElseSucceed(() => ""))).trim()
        const only = addresses.find((a) => !onLocalhost(a)) ?? ""
        return yield* unavailable(`listens only on ${only}; tailcat ${version === "" ? "here" : version} can only share servers on localhost`)
      })

      /**
       * tailcat's share of `port` (proxied to `target`) until it stops or the task no longer lists the server; `ready`
       * gets its address.
       */
      const share = (task: TaskId, port: number, target: string, key: string, ready: Deferred.Deferred<PortForward, Unavailable>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner
              .spawn(
                ChildProcess.make("bash", ["-c", WATCHDOG, "huntaway-tailcat", config.tailcatBin, "--json", "serve", "--key=new", target], {
                  detached: true,
                  env: config.agentEnv,
                  extendEnv: true,
                  stdin: { stream: Stream.never },
                }),
              )
              .pipe(Effect.mapError((e) => unavailable(`couldn't start tailcat: ${e.message}`)))
            const stderr = yield* Ref.make("")
            const reading = yield* Effect.forkScoped(
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
              // Its exit comes before the last of its stderr may have been read, and that has its reason (HE-84).
              yield* Fiber.await(reading)
              return yield* unavailable(whyNotStarted(code, yield* Ref.get(stderr), config.tailcatBin))
            }
            const since = Timestamp.make(DateTime.formatIso(yield* DateTime.now))
            const made: PortForward = { address: address.value, port, since }
            yield* Ref.update(shared, (m) => new Map([...m, [key, made]]))
            // Shown shared from now until the share ends, however it ends; gone from `shared` first, so that a client
            // told it ended and asking again gets a new one.
            const forget = Ref.update(shared, (m) => new Map([...m].filter(([k]) => k !== key)))
            yield* Effect.addFinalizer(() => Effect.andThen(forget, shownAs(task, port, unmarked(since))))
            yield* shownAs(task, port, marked(since))
            yield* Deferred.succeed(ready, made)
            yield* Effect.logInfo(`task ${task}: sharing its server on port ${port} with tailcat`)
            const gone = Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(CHECK_EVERY)
                if (!(yield* listed(task, port))) return "its server is gone"
                // Listed again after a scan that missed it (and wrote it without `forwarded`): shown shared again.
                yield* shownAs(task, port, marked(since))
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
        const addresses = row.servers.filter((s) => s.port === port).map((s) => s.address)
        if (addresses.length === 0) return yield* new NotFound({ what: "server", id: String(port) })
        const key = `${task}:${port}`
        // One start per share at a time, so two clicks don't start two; another port's or task's doesn't wait for it (HE-84).
        return yield* locks.withLock(["forward", key])(
          Effect.gen(function* () {
            const have = (yield* Ref.get(shared)).get(key)
            if (have !== undefined) {
              if (have.since !== undefined) yield* shownAs(task, port, marked(have.since))
              return have
            }
            const target = yield* targetOf(port, addresses)
            const ready = yield* Deferred.make<PortForward, Unavailable>()
            yield* FiberMap.run(shares, key, share(task, port, target, key, ready))
            return yield* Deferred.await(ready).pipe(
              Effect.timeoutOrElse({
                duration: START_TIMEOUT,
                orElse: () => Effect.andThen(FiberMap.remove(shares, key), Effect.fail(unavailable("tailcat didn't print an address in time"))),
              }),
            )
          }),
        )
      })

      return PortForwards.of({ forward })
    }).pipe(Effect.annotateLogs({ module: "servers" })),
  )

  /**
   * As the board starts: no server is shown shared, as the shares ended with the board that made them. With the loops
   * (`Main.RunLoops`), not in the layer: a read-only server builds that and changes nothing.
   */
  static readonly reset = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rewrite = yield* rewriter
      const rows = yield* sql<{ readonly id: string }>`SELECT id FROM tasks WHERE servers LIKE '%"forwarded"%'`.pipe(Effect.orDie)
      for (const r of rows) yield* rewrite(TaskId.make(r.id), null, unmarked())
    }),
  )
}
