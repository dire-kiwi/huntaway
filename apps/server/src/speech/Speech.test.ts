import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, FileSystem, Layer, Ref } from "effect"
import { Digest } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestPlatform } from "@huntaway/testing"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { modelUrl, type CatalogModel } from "./catalog.ts"
import { Speech } from "./Speech.ts"
import { SpeechEngine, SpeechEngineFailed } from "./SpeechEngine.ts"

// Dictation's models and transcribing (HE-89): models served by a fake HTTP client, never Hugging Face's, and a fake
// engine that hashes with Effect's digest and "hears" which file it was given.

const BYTES = new TextEncoder().encode("a speech model, in GGUF")

const model = (id: string, sha256: string): CatalogModel => ({
  id: `test/${id}`,
  revision: "r1",
  name: id,
  description: `The ${id} model`,
  filename: `${id}.gguf`,
  size: BYTES.byteLength,
  sha256,
  languages: ["en"],
  recommended: false,
})

/** The test's HTTP server: a model's bytes at its URL, after `gate` opens when one is set. */
const served = new Map<string, Uint8Array>()
const gate = Ref.makeUnsafe<Deferred.Deferred<void> | null>(null)
const fakeHttp = HttpClient.make((request, url) =>
  Effect.gen(function* () {
    const wait = yield* Ref.get(gate)
    if (wait !== null) yield* Deferred.await(wait)
    const bytes = served.get(url.toString())
    return HttpClientResponse.fromWeb(request, bytes === undefined ? new Response("not found", { status: 404 }) : new Response(bytes.slice()))
  }),
)

/** What the engine was asked to transcribe with. */
const heard = Ref.makeUnsafe<ReadonlyArray<string>>([])

const fakeEngine = (unsupported: string | null) =>
  Layer.effect(
    SpeechEngine,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const digest = yield* Digest.Digest
      return SpeechEngine.of({
        unsupported,
        sha256: (path) =>
          fs.readFile(path).pipe(
            Effect.flatMap((b) => digest.digestHex(Digest.sha256, b)),
            Effect.mapError((e) => new SpeechEngineFailed({ reason: e.message })),
          ),
        transcribe: (file) =>
          Effect.as(
            Ref.update(heard, (h) => [...h, file]),
            `  heard with ${file.slice(file.lastIndexOf("/") + 1)}  `,
          ),
      })
    }),
  )

const testSpeech = (catalog: ReadonlyArray<CatalogModel>, unsupported: string | null = null) =>
  Layer.effect(Speech, Speech.make(catalog)).pipe(
    Layer.provideMerge(fakeEngine(unsupported)),
    Layer.provideMerge(SettingsRepo.layer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fakeHttp)),
    Layer.provideMerge(TestPlatform()),
  )

const AUDIO = Base64.encode(new Uint8Array(16_000))

const shaOf = Effect.gen(function* () {
  return yield* (yield* Digest.Digest).digestHex(Digest.sha256, BYTES)
}).pipe(Effect.provide(Digest.layerWebCrypto))

describe("dictation", () => {
  it.effect("downloads a model, checks it, uses it, and transcribes with it", () =>
    Effect.gen(function* () {
      const sha = yield* shaOf
      const catalog = [model("small", sha), model("large", sha)]
      for (const m of catalog) served.set(modelUrl(m), BYTES)
      return yield* Effect.gen(function* () {
        const speech = yield* Speech
        const before = yield* speech.status
        assert.deepStrictEqual(
          before.models.map((m) => [m.id, m.installed]),
          [
            ["test/small", false],
            ["test/large", false],
          ],
        )
        assert.isNull(before.active)
        const none = yield* Effect.flip(speech.transcribe(AUDIO))
        assert.strictEqual(none._tag, "Unavailable")

        const started = yield* speech.download("test/large")
        assert.deepStrictEqual(started.downloading?.model, "test/large")
        yield* speech.settled
        const after = yield* speech.status
        assert.isNull(after.downloading)
        assert.isNull(after.failed)
        assert.strictEqual(after.active, "test/large")
        assert.deepStrictEqual(
          after.models.map((m) => m.installed),
          [false, true],
        )
        const dir = `${(yield* ServerConfig).dataDir}/speech/models`
        assert.deepStrictEqual(yield* (yield* FileSystem.FileSystem).readDirectory(dir), ["large.gguf"])

        assert.deepStrictEqual(yield* speech.transcribe(AUDIO), { text: "heard with large.gguf" })
        assert.deepStrictEqual(yield* Ref.get(heard), [`${dir}/large.gguf`])

        // A second model is used once it is in; the first can be chosen again, and removed.
        yield* speech.download("test/small")
        yield* speech.settled
        assert.strictEqual((yield* speech.status).active, "test/small")
        assert.strictEqual((yield* speech.select("test/large")).active, "test/large")
        assert.strictEqual((yield* speech.remove("test/large")).active, "test/small")
        assert.strictEqual((yield* Effect.flip(speech.select("test/large")))._tag, "NotFound")
        assert.strictEqual((yield* Effect.flip(speech.download("test/none")))._tag, "NotFound")
      }).pipe(Effect.provide(testSpeech(catalog)))
    }),
  )

  it.effect("keeps nothing of a download whose checksum or size is wrong, and says why", () => {
    const bad = model("bad", "0".repeat(64))
    const missing = { ...model("missing", "0".repeat(64)), revision: "gone" }
    served.set(modelUrl(bad), BYTES)
    return Effect.gen(function* () {
      const speech = yield* Speech
      yield* speech.download(bad.id)
      yield* speech.settled
      const s = yield* speech.status
      assert.strictEqual(s.failed?.model, bad.id)
      assert.include(s.failed?.reason, "SHA-256")
      assert.isNull(s.active)
      const dir = `${(yield* ServerConfig).dataDir}/speech/models`
      assert.deepStrictEqual(yield* (yield* FileSystem.FileSystem).readDirectory(dir), [])
      yield* speech.download(missing.id)
      yield* speech.settled
      assert.include((yield* speech.status).failed?.reason, "HTTP 404")
    }).pipe(Effect.provide(testSpeech([bad, missing])))
  })

  it.effect("downloads one model at a time, and a cancel stops it", () =>
    Effect.gen(function* () {
      const sha = yield* shaOf
      const catalog = [model("a", sha), model("b", sha)]
      for (const m of catalog) served.set(modelUrl(m), BYTES)
      const wait = yield* Deferred.make<void>()
      yield* Ref.set(gate, wait)
      return yield* Effect.gen(function* () {
        const speech = yield* Speech
        yield* speech.download("test/a")
        const second = yield* Effect.flip(speech.download("test/b"))
        assert.strictEqual(second._tag, "Conflict")
        const cancelled = yield* speech.cancel
        assert.isNull(cancelled.downloading)
        assert.isNull(cancelled.failed)
        assert.isTrue(cancelled.models.every((m) => !m.installed))
      }).pipe(Effect.provide(testSpeech(catalog)), Effect.ensuring(Ref.set(gate, null)))
    }),
  )

  it.effect("neither downloads nor transcribes where the engine has no build", () =>
    Effect.gen(function* () {
      const speech = yield* Speech
      assert.strictEqual((yield* Effect.flip(speech.transcribe(AUDIO)))._tag, "Unavailable")
      assert.strictEqual((yield* speech.status).unsupported, "no build here")
      assert.strictEqual((yield* Effect.flip(speech.download("test/x")))._tag, "Unavailable")
    }).pipe(Effect.provide(testSpeech([model("x", "0".repeat(64))], "no build here"))),
  )

  it.effect("refuses audio that isn't 16-bit PCM", () =>
    Effect.gen(function* () {
      const speech = yield* Speech
      const odd = yield* Effect.flip(speech.transcribe(Base64.encode(new Uint8Array(3))))
      assert.strictEqual(odd._tag, "Invalid")
      const text = yield* Effect.flip(speech.transcribe("not base64!"))
      assert.strictEqual(text._tag, "Invalid")
    }).pipe(Effect.provide(testSpeech([]))),
  )
})
