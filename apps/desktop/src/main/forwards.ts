import { Config, Deferred, Effect, FiberMap, Option, Ref, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Desktop } from "./Desktop.ts"

// HE-81: a task's dev server on the board's host, forwarded to this computer with tailcat (https://tailscale.com/tailcat).
// The board asks its host to share the server (`tasks.forwardServer`, which runs `tailcat serve` there) and gives the
// address here (`huntaway:forward-port`); this runs `tailcat forward <address> 0:<port>`, which listens on a free port
// on 127.0.0.1, and answers its URL. One forward per address and port, kept until the app quits or tailcat stops.

/** What `forward` answers: the local URL, or why there is none. */
export type ForwardAnswer = { readonly url: string } | { readonly error: string }

/** How long tailcat has to say where it listens. */
const START_TIMEOUT = "30 seconds"

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

/** The forwards, for the scope (the app's windows): `forward(address, port)` answers the local URL. */
export const makeForwards: Effect.Effect<
  { readonly forward: (address: unknown, port: unknown) => Effect.Effect<ForwardAnswer> },
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
  const urls = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
  const running = yield* FiberMap.make<string>()
  const starting = yield* Semaphore.make(1)

  /** `tailcat forward` for `key` until it stops; `ready` is completed with its URL or why it has none. */
  const run = (key: string, address: string, port: number, ready: (answer: ForwardAnswer) => Effect.Effect<void>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(bin, ["forward", address, `0:${port}`], { env: { PATH: desktop.path }, extendEnv: true, stdin: { stream: Stream.never } }),
        )
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
          const why = lastLine(yield* Ref.get(stderr))
          return yield* ready({ error: why === "" ? "tailcat stopped before it forwarded the port" : `tailcat: ${why}` })
        }
        const url = `http://${at.value}/`
        yield* Ref.update(urls, (m) => new Map([...m, [key, url]]))
        yield* ready({ url })
        return yield* Effect.ignore(child.exitCode)
      }),
    ).pipe(
      Effect.catch((e) =>
        ready({
          error: e.message.includes("ENOENT") ? `tailcat isn't installed on this computer (looked for ${bin}): see https://tailscale.com/tailcat` : e.message,
        }),
      ),
      Effect.ensuring(Ref.update(urls, (m) => new Map([...m].filter(([k]) => k !== key)))),
    )

  const forward = (address: unknown, port: unknown): Effect.Effect<ForwardAnswer> =>
    Effect.gen(function* () {
      if (!isTailcatAddress(address)) return { error: "That isn't a tailcat address." }
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return { error: "That isn't a port." }
      const key = `${address}:${port}`
      return yield* Semaphore.withPermits(
        starting,
        1,
      )(
        Effect.gen(function* () {
          const have = (yield* Ref.get(urls)).get(key)
          if (have !== undefined) return { url: have }
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
