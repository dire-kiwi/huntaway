import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { createHash } from "node:crypto"
import { createReadStream, writeSync } from "node:fs"
import type { TranscribeModel } from "transcribe-cpp"
import { joinTexts, pcmToFloat, splitAtPauses } from "./speech/audio.ts"
import { WorkerAnswer, WorkerRequest } from "./speech/workerProtocol.ts"

// The speech engine's process (HE-89): the server starts it with Node (speech/SpeechEngine.ts) when a dictation needs
// it and stops it once it has been idle a while, so the model's memory is given back. transcribe.cpp runs native
// code, which can crash; here that ends this process, not the server (T3 Code runs its engine the same way).
//
// Its stdin is one JSON request a line (`WorkerRequest`): a model's file and the audio to transcribe, as base64 of
// 16 kHz mono 16-bit PCM, or a downloaded model's file to hash. It answers each on a line of stdout (`WorkerAnswer`),
// in order, with the request's id. The model loaded stays loaded for the next request; a request for another file loads that one instead.

/** The most samples a model not made for long audio is given at once: 30 seconds, as T3 Code gives them. */
const PIECE = 16_000 * 30

const writeLine = (value: WorkerAnswer) =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(`${yield* Schema.encodeEffect(Schema.fromJsonString(WorkerAnswer))(value).pipe(Effect.orDie)}\n`)
    yield* Effect.sync(() => {
      let at = 0
      while (at < bytes.length) at += writeSync(1, bytes, at)
    })
  })

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

const main = Effect.gen(function* () {
  const engine = yield* Effect.tryPromise({ try: () => import("transcribe-cpp"), catch: reason }).pipe(Effect.option)
  const loaded = yield* Ref.make<{ readonly path: string; readonly model: TranscribeModel } | null>(null)

  /** The model in `path`, loaded once: on the backend transcribe.cpp picks (a GPU, if it has one), else on the CPU. */
  const modelAt = (path: string) =>
    Effect.gen(function* () {
      if (Option.isNone(engine)) return yield* Effect.fail("transcribe.cpp has no build for this platform")
      const { TranscribeModel } = engine.value
      const current = yield* Ref.get(loaded)
      if (current?.path === path) return current.model
      if (current !== null) current.model.dispose()
      yield* Ref.set(loaded, null)
      const model = yield* Effect.tryPromise({ try: () => TranscribeModel.load(path), catch: reason }).pipe(
        Effect.catch(() => Effect.tryPromise({ try: () => TranscribeModel.load(path, { backend: "cpu" }), catch: reason })),
      )
      yield* Ref.set(loaded, { path, model })
      return model
    })

  const sha256 = (path: string) =>
    Effect.gen(function* () {
      const hash = createHash("sha256")
      yield* Stream.fromAsyncIterable(createReadStream(path), reason).pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))))
      return hash.digest("hex")
    })

  const transcribe = (request: Extract<WorkerRequest, { readonly kind: "transcribe" }>) =>
    Effect.gen(function* () {
      const model = yield* modelAt(request.model)
      const pcm = pcmToFloat(yield* Effect.fromResult(Base64.decode(request.audio)).pipe(Effect.mapError(() => "the audio isn't base64")))
      const max = model.capabilities.maxAudioMs > 0 ? Math.min(PIECE, (model.capabilities.maxAudioMs * 16) / 2) : PIECE
      const pieces = model.supports("long_form") && model.capabilities.maxAudioMs === 0 ? [pcm] : splitAtPauses(pcm, max)
      const texts = yield* Effect.forEach(pieces, (piece) => Effect.tryPromise({ try: () => model.transcribe(piece), catch: reason }), {
        concurrency: 1,
      })
      return joinTexts(texts.map((r) => r.text))
    })

  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerRequest))
  yield* Stream.fromAsyncIterable(process.stdin, reason).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.runForEach((line) =>
      decode(line).pipe(
        Effect.matchEffect({
          onFailure: () => writeLine({ id: -1, ok: false, error: "the request isn't one" }),
          onSuccess: (request) =>
            (request.kind === "sha256" ? sha256(request.path) : transcribe(request)).pipe(
              Effect.match({
                onFailure: (error): WorkerAnswer => ({ id: request.id, ok: false, error }),
                onSuccess: (text): WorkerAnswer => ({ id: request.id, ok: true, text }),
              }),
              Effect.flatMap(writeLine),
            ),
        }),
      ),
    ),
  )
  // Its stdin closed: the server is done with it.
  return yield* Effect.sync(() => process.exit(0))
})

NodeRuntime.runMain(main)
