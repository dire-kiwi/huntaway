import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Cipher, Digest, Kdf, SecureRandom } from "effect/crypto"
import { decryptValue, deriveKey, V10_PASSWORD, versionOf } from "./chromiumCrypto.ts"

// Decrypting a Chromium `v10` cookie value (HE-49): derive the fixed Linux key and round-trip a value through
// AES-128-CBC with the same 16-space IV, including the Chrome 130+ host_key digest prefix that `decryptValue` strips.

const crypto = Layer.mergeAll(Kdf.layerWebCrypto, Cipher.layerWebCrypto, Digest.layerWebCrypto).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

const IV = new Uint8Array(16).fill(0x20)

describe("chromium cookie crypto", () => {
  it.effect("decrypts a v10 value encrypted with the derived key", () =>
    Effect.gen(function* () {
      const kdf = yield* Kdf.Kdf
      const cipher = yield* Cipher.Cipher
      const digest = yield* Digest.Digest
      const key = yield* deriveKey(kdf, V10_PASSWORD)
      const plaintext = new TextEncoder().encode("session=abc123")
      const body = yield* cipher.encrypt(key, plaintext, { iv: IV })
      const encrypted = Uint8Array.from([0x76, 0x31, 0x30, ...body]) // "v10" + ciphertext
      assert.strictEqual(versionOf(encrypted), "v10")
      const got = yield* decryptValue(cipher, digest, key, "github.com", encrypted, false)
      assert.strictEqual(new TextDecoder().decode(got ?? new Uint8Array()), "session=abc123")
      // A database of version 24 or later has the digest on every value: one without it isn't trusted.
      assert.isNull(yield* decryptValue(cipher, digest, key, "github.com", encrypted, true))
    }).pipe(Effect.provide(crypto)),
  )

  it.effect("strips the host_key sha256 prefix Chrome 130+ prepends", () =>
    Effect.gen(function* () {
      const kdf = yield* Kdf.Kdf
      const cipher = yield* Cipher.Cipher
      const digest = yield* Digest.Digest
      const key = yield* deriveKey(kdf, V10_PASSWORD)
      const host = "github.com"
      const sum = yield* digest.digest(Digest.sha256, new TextEncoder().encode(host))
      const value = new TextEncoder().encode("v")
      const body = yield* cipher.encrypt(key, Uint8Array.from([...sum, ...value]), { iv: IV })
      const encrypted = Uint8Array.from([0x76, 0x31, 0x30, ...body])
      const got = yield* decryptValue(cipher, digest, key, host, encrypted, true)
      assert.strictEqual(new TextDecoder().decode(got ?? new Uint8Array()), "v")
    }).pipe(Effect.provide(crypto)),
  )

  it.effect("returns null for a short or misaligned body", () =>
    Effect.gen(function* () {
      const kdf = yield* Kdf.Kdf
      const cipher = yield* Cipher.Cipher
      const digest = yield* Digest.Digest
      const key = yield* deriveKey(kdf, V10_PASSWORD)
      const got = yield* decryptValue(cipher, digest, key, "x.com", Uint8Array.from([0x76, 0x31, 0x30, 1, 2, 3]), false)
      assert.isNull(got)
    }).pipe(Effect.provide(crypto)),
  )
})
