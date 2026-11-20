import { Deferred, Effect, Fiber, Option, Predicate, Queue, Ref, Schema, Stream } from "effect"
import type { Cause, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { toJson } from "../../platform/columns.ts"

// The ACP agent's process (the adapter's and `acp-run --list-models`' client): JSON-RPC 2.0, one message to a line, on
// its stdin and stdout. Unlike Codex's client (`codex/rpc.ts`) a request's answer isn't awaited on its own: it comes out
// of `next` in the order the agent wrote it, after the session updates it wrote before it, so a turn's last updates are
// taken in before the prompt's answer ends it, and `session/load`'s history can be told from what follows. Lines that
// aren't JSON-RPC (an agent may print others on its stdout) go to `onStderr` with its stderr's lines, the last of which
// are kept for saying why it stopped. The process lives as long as the scope it is started in, and is killed (SIGKILL)
// when that closes. It is not detached: in a run it is in the adapter's process group, which ia-shim's kill reaches.

/** The agent couldn't be started, or a request of the adapter's failed (`code` the agent's JSON-RPC error code). */
export class AcpError extends Schema.TaggedError<AcpError, { readonly brand: unique symbol }>()("AcpError", {
  method: Schema.String,
  code: Schema.NullOr(Schema.Finite),
  reason: Schema.String,
}) {}

/** What the agent sent: a notification or request of its own, or the answer to one of the adapter's requests. */
export type AgentMessage =
  | { readonly _tag: "Notification"; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Request"; readonly id: unknown; readonly method: string; readonly params: unknown }
  | {
      readonly _tag: "Response"
      readonly id: number
      readonly result: unknown
      readonly error: { readonly code: number | null; readonly message: string } | null
    }

export interface AcpAgentOptions {
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  /** Added to the environment this process has. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** A line of its stderr (or of its stdout that isn't JSON-RPC). */
  readonly onStderr: (line: string) => Effect.Effect<void>
}

export interface AcpAgent {
  /** Send request `method`; its id, whose answer comes out of `next`. */
  readonly send: (method: string, params: unknown) => Effect.Effect<number>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>
  /** The next message from the agent, in order; null once it has exited and all were taken. */
  readonly next: Effect.Effect<AgentMessage | null>
  readonly respond: (id: unknown, result: unknown) => Effect.Effect<void>
  readonly respondError: (id: unknown, code: number, message: string) => Effect.Effect<void>
  /** The last lines of its stderr. */
  readonly stderrTail: Effect.Effect<string>
  /** Waits until it has exited, and says how. */
  readonly exited: Effect.Effect<string>
  /** Kill it (SIGKILL) now. */
  readonly kill: Effect.Effect<void>
}

/** How many of its stderr's last lines are kept. */
const TAIL_LINES = 20

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = Schema.decodeUnknownOption(Json)
const encoder = new TextEncoder()
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A JSON-RPC line, or null for one that isn't. */
const messageOf = (line: string): AgentMessage | null => {
  const v = Option.getOrUndefined(parse(line))
  if (!isRecord(v)) return null
  const method = v["method"]
  if (typeof method === "string") {
    return "id" in v && v["id"] !== null && v["id"] !== undefined
      ? { _tag: "Request", id: v["id"], method, params: v["params"] ?? null }
      : { _tag: "Notification", method, params: v["params"] ?? null }
  }
  const id = v["id"]
  if (typeof id !== "number") return null
  const error = v["error"]
  if (error !== undefined && error !== null) {
    const code = isRecord(error) && typeof error["code"] === "number" ? error["code"] : null
    const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "request failed"
    return { _tag: "Response", id, result: null, error: { code, message } }
  }
  return { _tag: "Response", id, result: v["result"] ?? null, error: null }
}

/** Start the agent for as long as the scope lasts. Fails if it can't be started. */
export const acpAgent = Effect.fnUntraced(function* (
  options: AcpAgentOptions,
): Effect.fn.Return<AcpAgent, AcpError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const writes = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const incoming = yield* Queue.unbounded<AgentMessage, Cause.Done>()
  const nextId = yield* Ref.make(1)
  const gone = yield* Ref.make(false)
  const tail = yield* Ref.make<ReadonlyArray<string>>([])
  const exit = yield* Deferred.make<string>()
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.program, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? {},
        extendEnv: true,
        detached: false,
        killSignal: "SIGKILL",
        stdin: { stream: Stream.fromQueue(writes), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(Effect.mapError((e) => new AcpError({ method: "", code: null, reason: `failed to start ${options.program}: ${e.message}` })))

  const stderrLine = (line: string) =>
    Effect.andThen(
      Ref.update(tail, (t) => [...t, line].slice(-TAIL_LINES)),
      options.onStderr(line),
    )

  const onLine = (line: string) => {
    const m = messageOf(line)
    if (m !== null) return Queue.offer(incoming, m)
    return line.trim() === "" ? Effect.void : stderrLine(line)
  }

  const reader = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(onLine),
    Effect.ignore,
    Effect.ensuring(Effect.andThen(Ref.set(gone, true), Queue.end(incoming))),
    Effect.forkScoped,
  )
  yield* handle.stderr.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(stderrLine), Effect.ignore, Effect.forkScoped)
  yield* handle.exitCode.pipe(
    Effect.map((code) => `exit status: ${Number(code)}`),
    Effect.catch((e) =>
      Effect.succeed(/signal: '([A-Z0-9]+)'/u.exec(e.message)?.[1] ?? null).pipe(Effect.map((s) => (s === null ? e.message : `signal: ${s}`))),
    ),
    Effect.flatMap((s) => Deferred.succeed(exit, s)),
    Effect.forkScoped,
  )
  yield* Effect.addFinalizer(() => Effect.andThen(Queue.end(writes), Fiber.interrupt(reader)))

  const write = (value: unknown) =>
    Effect.gen(function* () {
      if (yield* Ref.get(gone)) return
      const text = yield* toJson(value)
      yield* Queue.offer(writes, encoder.encode(`${text}\n`))
    })

  return {
    send: (method, params) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
        yield* write({ jsonrpc: "2.0", id, method, params })
        return id
      }),
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    next: Queue.take(incoming).pipe(Effect.orElseSucceed(() => null)),
    respond: (id, result) => write({ jsonrpc: "2.0", id, result }),
    respondError: (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } }),
    stderrTail: Effect.map(Ref.get(tail), (t) => t.join("\n")),
    exited: Deferred.await(exit),
    kill: Effect.ignore(handle.kill({ killSignal: "SIGKILL" })),
  }
})

/** JSON-RPC's code for a method the client doesn't have. */
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
