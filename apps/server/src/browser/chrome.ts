import { Effect, Fiber, Queue, Ref, Stream } from "effect"
import type { Cause, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { makeCdp } from "./cdp.ts"
import type { Cdp } from "./cdp.ts"

// One headless Chrome for this host's tasks (HE-62): a child of the server, spoken to over `--remote-debugging-pipe`
// (commands on its fd 3, answers and events on its fd 4, each message ended by a NUL), so no port is opened that
// another program could reach. It lives as long as the scope it is started in: closing that asks Chrome to close
// (so its profile is written out), then kills it.

/** How Chrome is started: the program, its profile folder, and whether it keeps its sandbox. */
export interface ChromeLaunch {
  readonly executable: string
  readonly profileDir: string
  readonly sandbox: boolean
}

export const chromeArgs = (launch: ChromeLaunch): ReadonlyArray<string> => [
  "--headless",
  "--remote-debugging-pipe",
  `--user-data-dir=${launch.profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  // Software compositing is cheaper on a server and still draws WebGL (SwiftShader).
  "--disable-gpu",
  // Every task's page draws and runs its timers as if in front: one in the background gives a viewer no frames.
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--hide-scrollbars",
  "--mute-audio",
  "--password-store=basic",
  "--use-mock-keychain",
  ...(launch.sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
]

export interface ChromeProcess {
  readonly cdp: Cdp
  /** The last of what Chrome wrote to stderr (at most 4,000 characters). */
  readonly stderr: Effect.Effect<string>
}

const encoder = new TextEncoder()

/** Whole messages from the pipe's text: each ends with a NUL. */
export const splitMessages = <E, R>(text: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  text.pipe(
    Stream.mapAccum(
      () => "",
      (rest, chunk) => {
        const parts = (rest + chunk).split("\0")
        const last = parts.pop() ?? ""
        return [last, parts] as const
      },
    ),
  )

/** Start Chrome for as long as the scope lasts; its connection is gone once it exits. */
export const startChrome = Effect.fnUntraced(function* (
  launch: ChromeLaunch,
): Effect.fn.Return<ChromeProcess, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const writes = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const errText = yield* Ref.make("")
  const lastLines = Effect.map(Ref.get(errText), (all) => {
    const last = all.trim().split("\n").slice(-3).join(" / ")
    return last === "" ? "" : `: ${last}`
  })

  const spawned = yield* spawner
    .spawn(
      ChildProcess.make(launch.executable, [...chromeArgs(launch)], {
        extendEnv: true,
        detached: false,
        killSignal: "SIGKILL",
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        additionalFds: { fd3: { type: "input", stream: Stream.fromQueue(writes) }, fd4: { type: "output" } },
      }),
    )
    .pipe(Effect.result)

  if (spawned._tag === "Failure") {
    const why = `Chrome couldn't start (${spawned.failure.message})`
    const cdp = yield* makeCdp(() => Effect.void, Stream.empty, Effect.succeed(why))
    return { cdp, stderr: Effect.succeed(why) }
  }
  const handle = spawned.success
  const errors = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(errText, (all) => (all + chunk).slice(-4000))),
    Effect.ignore,
    Effect.forkScoped,
  )
  const exited = handle.exitCode.pipe(
    Effect.map((code) => `Chrome exited (${Number(code)})`),
    Effect.orElseSucceed(() => "Chrome stopped"),
    Effect.flatMap((why) =>
      Effect.andThen(
        Fiber.await(errors),
        Effect.map(lastLines, (said) => `${why}${said}`),
      ),
    ),
  )
  const cdp = yield* makeCdp(
    (message) => Queue.offer(writes, encoder.encode(`${message}\0`)).pipe(Effect.asVoid),
    splitMessages(handle.getOutputFd(4).pipe(Stream.decodeText())),
    exited,
  )
  // Asked to close first, so the profile (cookies, storage) is written out; killed with the scope after.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if ((yield* cdp.status) === null) yield* cdp.send("Browser.close", {}, undefined, "2 seconds").pipe(Effect.ignore)
      yield* Queue.end(writes)
      yield* cdp.closed.pipe(Effect.timeoutOption("3 seconds"))
    }),
  )
  return { cdp, stderr: Ref.get(errText) }
})
