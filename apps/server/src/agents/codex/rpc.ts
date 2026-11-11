import { Deferred, Effect, Fiber, Option, Predicate, Queue, Ref, Schema, Stream } from "effect"
import type { Scope, Cause } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { toJson } from "../../platform/columns.ts"

// A JSON-RPC client for `codex app-server` (huntaway's agent/codex/rpc.ts): one process, spoken to in JSON lines with no
// `jsonrpc` field. Requests are `{id, method, params}` and answered `{id, result}` or `{id, error: {message}}`; what the
// server sends of its own (notifications `{method, params}` and requests `{id, method, params}`) comes out of `next`, in
// order. The adapter (`huntaway codex-run`) and the board's one-off queries (models, skills, rate limits, titles) both
// use it. The process lives as long as the scope it is started in, and is killed (SIGKILL) when that closes. It is not
// detached: in a run it is in the adapter's process group, which ia-shim's kill reaches.

/** A request to the app-server failed: it answered with an error, or it exited (or never started: `method` is ""). */
export class AppServerError extends Schema.TaggedError<AppServerError, { readonly brand: unique symbol }>()("AppServerError", {
  /** The request's method (or what failed, such as starting it). */
  method: Schema.String,
  reason: Schema.String,
}) {}

/** A message the app-server sent of its own accord: a notification (no `id`) or a request (with one). */
export type Incoming = Readonly<Record<string, unknown>>

export interface AppServerOptions {
  /** The program (`codex`, or `$HUNTAWAY_CODEX_BIN`). */
  readonly program: string
  /** Config overrides (`-c key=value` each), such as a run's telemetry's. */
  readonly overrides?: ReadonlyArray<string> | undefined
  readonly cwd: string
  /** Added to the environment this process has (`CODEX_HOME`, say). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Its stderr: this process's own (`inherit`, the adapter's, which goes to the run's `err.log`), or dropped. */
  readonly stderr?: "inherit" | "ignore" | undefined
}

export interface AppServer {
  /** Send a request and wait for its result. Fails with the app-server's error message, or once it has exited. */
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, AppServerError>
  /** Send a notification (`{method}`, with `params` if given). */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>
  /** The handshake every client starts with: `initialize` (as huntaway, with the experimental API), then `initialized`. */
  readonly initialize: (version: string) => Effect.Effect<unknown, AppServerError>
  /** The next notification or request from the app-server, in order; null once it has exited and all were taken. */
  readonly next: Effect.Effect<Incoming | null>
  /** Answer the app-server's request `id` with `result`. */
  readonly respond: (id: unknown, result: unknown) => Effect.Effect<void>
  /** Answer the app-server's request `id` with an error (code -32601). */
  readonly respondError: (id: unknown, message: string) => Effect.Effect<void>
  /** How it exited (`exit status: 1`, `signal: SIGKILL`), once it has; null before. */
  readonly exitStatus: Effect.Effect<string | null>
  /** Waits until it has exited, and says how. */
  readonly exited: Effect.Effect<string>
}

/** An error as the old server's `err_str` said it: `<method>: <reason>`, or the reason alone when it is not a request's. */
export const errorText = (e: AppServerError): string => (e.method === "" ? e.reason : `${e.method}: ${e.reason}`)

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = Schema.decodeUnknownOption(Json)
const encoder = new TextEncoder()

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** Start `codex [-c k=v …] app-server` for as long as the scope lasts. Fails if it can't be started. */
export const appServer = Effect.fnUntraced(function* (
  options: AppServerOptions,
): Effect.fn.Return<AppServer, AppServerError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const writes = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const incoming = yield* Queue.unbounded<Incoming, Cause.Done>()
  const pending = yield* Ref.make<ReadonlyMap<number, { readonly method: string; readonly done: Deferred.Deferred<unknown, AppServerError> }>>(new Map())
  const nextId = yield* Ref.make(1)
  const gone = yield* Ref.make(false)
  const status = yield* Ref.make<string | null>(null)
  const exit = yield* Deferred.make<string>()
  const args = [...(options.overrides ?? []).flatMap((o) => ["-c", o]), "app-server"]
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.program, args, {
        cwd: options.cwd,
        env: options.env ?? {},
        extendEnv: true,
        detached: false,
        killSignal: "SIGKILL",
        stdin: { stream: Stream.fromQueue(writes), endOnDone: true },
        stdout: "pipe",
        stderr: options.stderr ?? "inherit",
      }),
    )
    .pipe(Effect.mapError((e) => new AppServerError({ method: "", reason: `failed to start ${options.program} app-server: ${e.message}` })))

  /** The process is gone: whatever still waits fails, and `next` ends. */
  const ended = Effect.gen(function* () {
    if (yield* Ref.getAndSet(gone, true)) return
    const waiting = yield* Ref.getAndSet(pending, new Map())
    for (const p of waiting.values()) {
      yield* Deferred.fail(p.done, new AppServerError({ method: "", reason: `codex app-server exited during ${p.method}` }))
    }
    yield* Queue.end(incoming)
  })

  const onLine = Effect.fnUntraced(function* (line: string) {
    const v = Option.getOrUndefined(parse(line))
    if (!isRecord(v)) return
    if ("method" in v) {
      yield* Queue.offer(incoming, v)
      return
    }
    // A response to one of ours.
    const id = v["id"]
    if (typeof id !== "number" || !Number.isInteger(id)) return
    const all = yield* Ref.get(pending)
    const p = all.get(id)
    if (p === undefined) return
    yield* Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== id)))
    const error = v["error"]
    if (error !== undefined) {
      const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "request failed"
      yield* Deferred.fail(p.done, new AppServerError({ method: p.method, reason: message }))
    } else yield* Deferred.succeed(p.done, v["result"] ?? null)
  })

  const reader = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(onLine),
    Effect.ignore,
    Effect.ensuring(ended),
    Effect.forkScoped,
  )
  // How it exited, once it has.
  yield* handle.exitCode.pipe(
    Effect.map((code) => `exit status: ${Number(code)}`),
    Effect.catch((e) =>
      Effect.succeed(/signal: '([A-Z0-9]+)'/u.exec(e.message)?.[1] ?? null).pipe(Effect.map((s) => (s === null ? e.message : `signal: ${s}`))),
    ),
    Effect.flatMap((s) => Effect.andThen(Ref.set(status, s), Deferred.succeed(exit, s))),
    Effect.forkScoped,
  )
  // Once the scope closes: nothing more is written, and the reader stops.
  yield* Effect.addFinalizer(() => Effect.andThen(Queue.end(writes), Fiber.interrupt(reader)))

  const write = (value: unknown) =>
    Effect.gen(function* () {
      if (yield* Ref.get(gone)) return false
      const text = yield* toJson(value)
      yield* Queue.offer(writes, encoder.encode(`${text}\n`))
      return true
    })

  const request = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<unknown, AppServerError>()
      const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
      if (yield* Ref.get(gone)) return yield* new AppServerError({ method: "", reason: "codex app-server exited" })
      yield* Ref.update(pending, (m) => new Map([...m, [id, { method, done }]]))
      yield* write({ id, method, params: params ?? null })
      return yield* Deferred.await(done)
    })

  const notify = (method: string, params?: unknown) => Effect.asVoid(write(params === undefined ? { method } : { method, params }))

  const server: AppServer = {
    request,
    notify,
    initialize: (version) =>
      Effect.gen(function* () {
        const r = yield* request("initialize", { clientInfo: { name: "huntaway", title: "Huntaway", version }, capabilities: { experimentalApi: true } })
        yield* notify("initialized")
        return r
      }),
    next: Queue.take(incoming).pipe(Effect.orElseSucceed(() => null)),
    respond: (id, result) => Effect.asVoid(write({ id: id ?? null, result })),
    respondError: (id, message) => Effect.asVoid(write({ id: id ?? null, error: { code: -32601, message } })),
    exitStatus: Ref.get(status),
    exited: Deferred.await(exit),
  }
  return server
})
