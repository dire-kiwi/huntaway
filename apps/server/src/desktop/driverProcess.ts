import { Deferred, Effect, Fiber, Option, Predicate, Queue, Ref, Schema, Stream } from "effect"
import { Duration } from "effect"
import type { Cause, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { toJson } from "../platform/columns.ts"

// One running `cua-driver mcp` (huntaway's desktop/driver.ts `Process`): a child of this server spoken MCP to over its
// stdio, in newline-delimited JSON-RPC. It lives as long as the scope it is started in, and is killed (SIGKILL) when
// that closes; `close` ends its stdin first, which ends the driver's runtime cleanly. Its own requests and its
// notifications are dropped (it has none the board takes).

/** The driver failed a request: it answered with an error, didn't answer in time, or isn't running. */
export class DriverError extends Schema.TaggedError<DriverError, { readonly brand: unique symbol }>()("DriverError", {
  reason: Schema.String,
}) {}

export interface DriverProcess {
  /** Send a request and wait at most `timeout` for its result. `what` names it in a timeout's message. */
  readonly request: (method: string, params: unknown, timeout: Duration.Input, what: string) => Effect.Effect<unknown, DriverError>
  /** Send a notification. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>
  /** End its stdin: the driver then exits on its own. */
  readonly close: Effect.Effect<void>
  /** The last of what it wrote to stderr (at most 4,000 characters). */
  readonly stderr: Effect.Effect<string>
  /** Waits until it has exited, and says how: "exited (0)", "stopped (SIGKILL)", "couldn't start (…)". */
  readonly exited: Effect.Effect<string>
  /** How it exited, once it has; null before. */
  readonly exitStatus: Effect.Effect<string | null>
}

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = Schema.decodeUnknownOption(Json)
const encoder = new TextEncoder()

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A short reason from the driver's last stderr lines, as the old one appended it. */
const withStderr = (why: string, stderr: string) => {
  const last = stderr.trim()
  return last === "" ? `Cua Driver ${why}` : `Cua Driver ${why}: ${last.split("\n").slice(-3).join(" / ")}`
}

/** Start `<path> mcp` with `env` over the server's own environment for as long as the scope lasts. */
export const startDriver = Effect.fnUntraced(function* (
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<DriverProcess, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const writes = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const pending = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<unknown, DriverError>>>(new Map())
  const nextId = yield* Ref.make(1)
  const status = yield* Ref.make<string | null>(null)
  const errText = yield* Ref.make("")
  const exit = yield* Deferred.make<string>()

  /** It is gone (`why`): whatever still waits fails, and nothing more is written. */
  const ended = (why: string) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(status)) !== null) return
      yield* Ref.set(status, why)
      const said = withStderr(why, yield* Ref.get(errText))
      for (const p of (yield* Ref.getAndSet(pending, new Map())).values()) yield* Deferred.fail(p, new DriverError({ reason: said }))
      yield* Queue.end(writes)
      yield* Deferred.succeed(exit, why)
    })

  const spawned = yield* spawner
    .spawn(
      ChildProcess.make(path, ["mcp"], {
        env: { ...env },
        extendEnv: true,
        detached: false,
        killSignal: "SIGKILL",
        stdin: { stream: Stream.fromQueue(writes), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(Effect.result)
  if (spawned._tag === "Failure") {
    yield* ended(`couldn't start (${spawned.failure.message})`)
  } else {
    const handle = spawned.success
    const onLine = Effect.fnUntraced(function* (line: string) {
      const v = Option.getOrUndefined(parse(line))
      // Its own requests (it has none we take) and notifications are dropped.
      if (!isRecord(v) || "method" in v) return
      const id = v["id"]
      if (typeof id !== "number") return
      const p = (yield* Ref.get(pending)).get(id)
      if (p === undefined) return
      yield* Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== id)))
      const error = v["error"]
      if (error !== undefined && error !== null) {
        const message =
          isRecord(error) && typeof error["message"] === "string" ? error["message"] : (Option.getOrNull(Schema.encodeOption(Json)(error)) ?? "error")
        yield* Deferred.fail(p, new DriverError({ reason: message }))
      } else yield* Deferred.succeed(p, v["result"] ?? null)
    })
    const reader = yield* handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(onLine), Effect.ignore, Effect.forkScoped)
    const errors = yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(errText, (all) => (all + chunk).slice(-4000))),
      Effect.ignore,
      Effect.forkScoped,
    )
    yield* handle.exitCode.pipe(
      Effect.map((code) => `exited (${Number(code)})`),
      Effect.catch((e) => Effect.succeed(`stopped (${/signal: '?([A-Z0-9]+)'?/u.exec(e.message)?.[1] ?? e.message})`)),
      // What it wrote last is read before it is said to have gone.
      Effect.flatMap((why) => Effect.andThen(Fiber.await(reader), Effect.andThen(Fiber.await(errors), ended(why)))),
      Effect.forkScoped,
    )
    yield* Effect.addFinalizer(() => Effect.andThen(Queue.end(writes), Effect.andThen(Fiber.interrupt(reader), Fiber.interrupt(errors))))
  }

  const write = (value: unknown) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(status)) !== null) return
      yield* Queue.offer(writes, encoder.encode(`${yield* toJson(value)}\n`))
    })

  const request = (method: string, params: unknown, timeout: Duration.Input, what: string) =>
    Effect.gen(function* () {
      const gone = yield* Ref.get(status)
      if (gone !== null) return yield* new DriverError({ reason: withStderr(gone, yield* Ref.get(errText)) })
      const done = yield* Deferred.make<unknown, DriverError>()
      const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
      yield* Ref.update(pending, (m) => new Map([...m, [id, done]]))
      yield* write({ jsonrpc: "2.0", id, method, params })
      return yield* Deferred.await(done).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== id))).pipe(
              Effect.andThen(Effect.fail(new DriverError({ reason: `Cua Driver didn't answer ${what} within ${Math.round(Duration.toSeconds(timeout))}s` }))),
            ),
        }),
      )
    })

  const server: DriverProcess = {
    request,
    notify: (method, params = {}) => write({ jsonrpc: "2.0", method, params }),
    close: Queue.end(writes).pipe(Effect.asVoid),
    stderr: Ref.get(errText),
    exited: Deferred.await(exit),
    exitStatus: Ref.get(status),
  }
  return server
})
