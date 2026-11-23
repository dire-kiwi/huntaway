import { Context, Deferred, Effect, Exit, FiberHandle, Layer, Option, Queue, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import type { Cause, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { WorkerAnswer, type WorkerRequest } from "./workerProtocol.ts"

// The speech engine (HE-89): transcribe.cpp in a process of its own (src/speech-worker.ts), started with this server's
// Node the first time it is needed and stopped once it has had nothing to do for `IDLE`, which gives back the memory
// its model takes (a gigabyte or so). One request at a time goes to it; it answers them in order. When it exits (a
// crash in native code, say), what it was asked fails and the next request starts it again.

/** The engine couldn't do what it was asked: why, as the composer shows it. */
export class SpeechEngineFailed extends Schema.TaggedError<SpeechEngineFailed, { readonly brand: unique symbol }>()("SpeechEngineFailed", {
  reason: Schema.String,
}) {}

/** The platforms transcribe.cpp has a prebuilt engine for (`ServerConfig.platform`). */
const SUPPORTED = new Set(["linux-x64", "linux-arm64", "mac-arm64", "mac-x64", "win32-x64"])

/** How long the engine stays loaded after its last request. */
const IDLE = "10 minutes"

/** The longest a request may take: five minutes of audio on a slow CPU, or hashing a large model. */
const TIMEOUT = "5 minutes"

export interface SpeechEngineShape {
  /** Null when this host can transcribe; else why not. */
  readonly unsupported: string | null
  /** What the model in the file `model` hears in `audio` (base64 of 16 kHz mono 16-bit PCM). */
  readonly transcribe: (model: string, audio: string) => Effect.Effect<string, SpeechEngineFailed>
  /** The SHA-256 of the file `path`, in hex. */
  readonly sha256: (path: string) => Effect.Effect<string, SpeechEngineFailed>
}

const encoder = new TextEncoder()

/** `Omit` over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(WorkerAnswer))

interface Worker {
  readonly ask: (request: WorkerRequest) => Effect.Effect<string, SpeechEngineFailed>
  readonly gone: Effect.Effect<boolean>
  readonly scope: Scope.Closeable
}

/** The worker's file beside this one, as this server runs its sources: `.ts` from a checkout, `.js` in a release. */
const workerFile = () => {
  const ext = import.meta.url.endsWith(".js") ? "js" : "ts"
  return decodeURIComponent(new URL(`../speech-worker.${ext}`, import.meta.url).pathname)
}

export class SpeechEngine extends Context.Service<SpeechEngine, SpeechEngineShape>()("huntaway-server/speech/SpeechEngine") {
  static readonly layer = Layer.effect(
    SpeechEngine,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const current = yield* Ref.make<Worker | null>(null)
      const idle = yield* FiberHandle.make<void, never>()

      const start = Effect.gen(function* () {
        const scope = yield* Scope.fork(layerScope)
        const writes = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        const answers = yield* Queue.unbounded<string>()
        const exited = yield* Deferred.make<string>()
        const errText = yield* Ref.make("")
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(config.nodeBin, ["--disable-warning=ExperimentalWarning", workerFile()], {
              extendEnv: true,
              killSignal: "SIGKILL",
              stdin: { stream: Stream.fromQueue(writes), endOnDone: true },
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(
            Scope.provide(scope),
            Effect.mapError((e: PlatformError.PlatformError) => new SpeechEngineFailed({ reason: `the speech engine couldn't start: ${e.message}` })),
          )
        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Queue.offer(answers, line)),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(errText, (all) => (all + chunk).slice(-2000))),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        yield* handle.exitCode.pipe(
          Effect.map((code) => `exited (${Number(code)})`),
          Effect.catch((e) => Effect.succeed(`stopped (${e.message})`)),
          Effect.flatMap((why) => Deferred.succeed(exited, why)),
          Effect.forkIn(scope),
        )
        yield* Scope.addFinalizer(scope, Queue.end(writes))

        const ask = (request: WorkerRequest) =>
          Effect.gen(function* () {
            yield* Queue.offer(writes, encoder.encode(`${yield* encodeRequest(request).pipe(Effect.orDie)}\n`))
            const gone = Deferred.await(exited).pipe(
              Effect.flatMap((why) =>
                Effect.flatMap(Ref.get(errText), (err) => {
                  const last = err.trim().split("\n").slice(-2).join(" / ")
                  return Effect.fail(new SpeechEngineFailed({ reason: `the speech engine ${why}${last === "" ? "" : `: ${last}`}` }))
                }),
              ),
            )
            // Lines that aren't the answer to this request are skipped: one left by a request given up on, or stray output.
            while (true) {
              const answer = Option.getOrUndefined(decodeAnswer(yield* Effect.raceFirst(Queue.take(answers), gone)))
              if (answer === undefined || answer.id !== request.id) continue
              if (!answer.ok) return yield* new SpeechEngineFailed({ reason: answer.error })
              return answer.text
            }
          })
        return { ask, gone: Deferred.isDone(exited), scope } satisfies Worker
      })

      /** The worker running, started if none is (or the last one has gone). */
      const worker = Effect.gen(function* () {
        const w = yield* Ref.get(current)
        if (w !== null && !(yield* w.gone)) return w
        if (w !== null) yield* Scope.close(w.scope, Exit.void)
        const fresh = yield* start
        yield* Ref.set(current, fresh)
        return fresh
      })

      /** Stop the worker `IDLE` after now, unless asked something before then. */
      const stopLater = FiberHandle.run(
        idle,
        Effect.gen(function* () {
          yield* Effect.sleep(IDLE)
          yield* lock.withPermit(
            Effect.gen(function* () {
              const w = yield* Ref.getAndSet(current, null)
              if (w !== null) yield* Scope.close(w.scope, Exit.void)
            }),
          )
        }),
      )

      const nextId = yield* Ref.make(0)
      const ask = (request: DistributiveOmit<WorkerRequest, "id">) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              yield* FiberHandle.clear(idle)
              const w = yield* worker
              const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
              /** Stop the worker: the next request starts another. */
              const stop = Effect.andThen(Ref.set(current, null), Scope.close(w.scope, Exit.void))
              return yield* w.ask({ ...request, id }).pipe(
                Effect.timeoutOrElse({
                  duration: TIMEOUT,
                  orElse: () => Effect.andThen(stop, Effect.fail(new SpeechEngineFailed({ reason: "the speech engine took too long" }))),
                }),
                // Nobody waits for the answer any more (a cancelled download, a client gone): the work it does is
                // stopped with it, rather than left to finish for no one.
                Effect.onInterrupt(() => stop),
              )
            }),
          )
          .pipe(Effect.ensuring(stopLater))

      return SpeechEngine.of({
        unsupported: SUPPORTED.has(config.platform) ? null : `transcribe.cpp has no build for ${config.platform}`,
        transcribe: (model, audio) => ask({ kind: "transcribe", model, audio }),
        sha256: (path) => ask({ kind: "sha256", path }),
      })
    }),
  )
}
