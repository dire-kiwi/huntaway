import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { Digest } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { TestPlatform } from "@huntaway/testing"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { SpeechEngine } from "./SpeechEngine.ts"

// The speech engine's real process (src/speech-worker.ts), with no model: it hashes a file, says why it can't load a
// model that isn't there, and is still there for the next request after a failed one.

const TestEngine = SpeechEngine.layer.pipe(Layer.provideMerge(TestPlatform()))

describe("the speech engine", () => {
  it.live(
    "runs in a process of its own and answers each request in turn",
    () =>
      Effect.gen(function* () {
        const engine = yield* SpeechEngine
        const fs = yield* FileSystem.FileSystem
        const file = `${(yield* ServerConfig).dataDir}/model.gguf`
        const bytes = new TextEncoder().encode("not really a model")
        yield* fs.writeFile(file, bytes).pipe(Effect.orDie)
        assert.strictEqual(yield* engine.sha256(file), yield* (yield* Digest.Digest).digestHex(Digest.sha256, bytes))
        const missing = yield* Effect.flip(engine.transcribe(`${file}.none`, Base64.encode(new Uint8Array(320))))
        assert.include(missing.reason, "not found")
        const garbled = yield* Effect.flip(engine.transcribe(file, Base64.encode(new Uint8Array(320))))
        assert.isNotEmpty(garbled.reason)
        // Still answering after the failures.
        assert.strictEqual((yield* engine.sha256(file)).length, 64)
      }).pipe(Effect.provide(TestEngine)),
    60_000,
  )
})
