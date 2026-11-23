import { Config, Deferred, Effect, FiberMap, Option, RcMap, Ref, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Desktop } from "./Desktop.ts"
import { serverPath } from "./install.ts"

// HE-81: a task's dev server on the board's host, forwarded to this computer with tailcat (https://tailscale.com/tailcat).
// The board asks its host to share the server (`tasks.forwardServer`, which runs `tailcat serve` there) and gives the
// address here (`huntaway:forward-port`); this runs `tailcat forward <address> 0:<port>`, which listens on a free port
// on 127.0.0.1, and answers its URL. One forward per board, host and port (HE-82): the host's next share of that port
// has a new address, and asking for it stops the forward of the old one, which leads nowhere (tailcat says nothing when
// its peer is gone). Kept until then, the app quits or tailcat stops; under the watchdog, so they go with the app.

/** What `forward` answers: the local URL, or why there is none. */
export type ForwardAnswer = { readonly url: string } | { readonly error: string }

/** How long tailcat has to say where it listens. */
const START_TIMEOUT = "30 seconds"

/**
 * `bash -c WATCHDOG <name> <command> <args…>` runs the command with its stdin taken from the app's pipe: when that
 * closes (the app is gone, even crashed), its process group (spawned `detached`) dies. The server's `Proc.WATCHDOG`.
 */
export const WATCHDOG = `exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@"`

/** A tailcat address, as `tailcat serve` prints it (and no longer than any it prints). */
export const isTailcatAddress = (value: unknown): value is string => typeof value === "string" && /^tc[A-Za-z0-9_-]{8,1024}$/.test(value)

/** Where `tailcat forward` listens, from its line `# forwarding 127.0.0.1:43265 -> remote localhost:38701`, or null. */
export const forwardedAt = (line: string): string | null => /^#?\s*forwarding (127\.0\.0\.1:\d+|\[::1\]:\d+) ->/.exec(line.trim())?.[1] ?? null

/** The line of tailcat's stderr that says why it stopped (its last, without the `# `). */
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^#\s*/, "").trim())
    .findLast((l) => l !== "") ?? ""

/** How tailcat is run: detached, so its process group is its own (the watchdog's kill), with stdin a pipe kept open. */
const options = (PATH: string) => ({ detached: true, env: { PATH }, extendEnv: true, stdin: { stream: Stream.never } })

/** A host's id, as the board gives it. */
const isHostId = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= 256

/**
 * The forwards, for the scope (the app's windows): `forward(board, address, port, host)` answers the local URL of the
 * share at `address` of `port` on the board's host `host`. A board that gives no host (one from before HE-82) has a
 * forward per address and port, which a new share doesn't replace.
 */
export const makeForwards: Effect.Effect<
  { readonly forward: (board: string, address: unknown, port: unknown, host?: unknown) => Effect.Effect<ForwardAnswer> },
  never,
  Desktop | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> = Effect.gen(function* () {
  const desktop = yield* Desktop
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const given = yield* Config.String("HUNTAWAY_TAILCAT").pipe(Config.option, Effect.orElseSucceed(Option.none))
  const bin = Option.getOrElse(
    Option.filter(given, (b) => b !== ""),
    () => "tailcat",
  )
  // The login shell's PATH in front of the app's, as the server is started with: an app started from the Dock or a
  // desktop launcher has a minimal one, without ~/go/bin, Homebrew's or ~/.local/bin, where tailcat may be.
  const path = yield* Effect.cached(Effect.provideService(serverPath(desktop), ChildProcessSpawner.ChildProcessSpawner, spawner))
  // By board, host and port: the address forwarded and its URL.
  const urls = yield* Ref.make<ReadonlyMap<string, { readonly address: string; readonly url: string }>>(new Map())
  const running = yield* FiberMap.make<string>()
  // A lock per forward, for its start: two clicks don't start two, and a slow start doesn't hold up another's (HE-84).
  const locks = yield* RcMap.make({ lookup: () => Semaphore.make(1) })

  const notInstalled = `tailcat isn't installed on this computer (looked for ${bin}): see https://tailscale.com/tailcat`

  /** `tailcat forward` for `key` until it stops; `ready` is completed with its URL or why it has none. */
  const run = (key: string, address: string, port: number, ready: (answer: ForwardAnswer) => Effect.Effect<void>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const PATH = yield* path
        const args = ["forward", address, `0:${port}`]
        // Windows has no bash: there tailcat only goes with the app when the app quits.
        const command =
          desktop.platform === "win32"
            ? ChildProcess.make(bin, args, options(PATH))
            : ChildProcess.make("bash", ["-c", WATCHDOG, "huntaway-tailcat", bin, ...args], options(PATH))
        const child = yield* spawner.spawn(command)
        const stderr = yield* Ref.make("")
        const at = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.tap((text) => Ref.update(stderr, (s) => (s + text).slice(-2000))),
          Stream.splitLines,
          Stream.map(forwardedAt),
          Stream.filter((a) => a !== null),
          Stream.runHead,
          Effect.orElseSucceed(() => Option.none<string>()),
        )
        if (Option.isNone(at)) {
          const code = yield* child.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => null),
          )
          // bash's for a command it can't find.
          if (code === 127) return yield* ready({ error: notInstalled })
          const why = lastLine(yield* Ref.get(stderr))
          return yield* ready({ error: why === "" ? "tailcat stopped before it forwarded the port" : `tailcat: ${why}` })
        }
        const url = `http://${at.value}/`
        yield* Ref.update(urls, (m) => new Map([...m, [key, { address, url }]]))
        yield* ready({ url })
        return yield* Effect.ignore(child.exitCode)
      }),
    ).pipe(
      Effect.catch((e) => ready({ error: e.reason._tag === "NotFound" ? notInstalled : e.message })),
      // Unless a forward of a newer share has it already.
      Effect.ensuring(Ref.update(urls, (m) => new Map([...m].filter(([k, v]) => k !== key || v.address !== address)))),
    )

  const forward = (board: string, address: unknown, port: unknown, host?: unknown): Effect.Effect<ForwardAnswer> =>
    Effect.gen(function* () {
      if (!isTailcatAddress(address)) return { error: "That isn't a tailcat address." }
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return { error: "That isn't a port." }
      if (host !== undefined && !isHostId(host)) return { error: "That isn't a host." }
      // Only the host's id may have a space in it, and it goes last.
      const key = host === undefined ? `${address}:${port}` : `${port} ${board} ${host}`
      const lock = (body: Effect.Effect<ForwardAnswer>) => Effect.scoped(Effect.flatMap(RcMap.get(locks, key), (s) => Semaphore.withPermits(s, 1)(body)))
      return yield* lock(
        Effect.gen(function* () {
          const have = (yield* Ref.get(urls)).get(key)
          if (have?.address === address) return { url: have.url }
          // The forward of the host's last share of the port, which leads nowhere now: stopped, and waited for.
          yield* FiberMap.remove(running, key)
          const ready = yield* Deferred.make<ForwardAnswer>()
          yield* FiberMap.run(
            running,
            key,
            run(key, address, port, (a) => Effect.asVoid(Deferred.succeed(ready, a))),
          )
          return yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: START_TIMEOUT,
              orElse: () => Effect.as(FiberMap.remove(running, key), { error: "tailcat didn't forward the port in time" }),
            }),
          )
        }),
      )
    })

  return { forward }
})
