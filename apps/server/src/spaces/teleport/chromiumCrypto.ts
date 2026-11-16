import { Effect } from "effect"
import { Cipher, Digest, Kdf } from "effect/crypto"

// Decrypting a Chromium cookie value on Linux (HE-49), after Cua's `chromium_crypto`: the value's 3-byte prefix names
// the key — `v10` is the fixed `peanuts` password, `v11` the libsecret Safe Storage secret (read by the caller through
// `secret-tool`), `v20` is app-bound and can't be read by anything but Chrome's own service, so it is skipped. Both
// `v10` and `v11` derive a 128-bit AES-CBC key: PBKDF2-HMAC-SHA1 over the secret with the fixed `saltysalt` salt and
// one round, then AES-128-CBC with a fixed IV of 16 spaces and PKCS#7 padding. Chrome 130+ puts the SHA-256 of the
// row's host_key in front of the plaintext, which is stripped here.

const SALT = new TextEncoder().encode("saltysalt")
const IV = new Uint8Array(16).fill(0x20)
/** PBKDF2-HMAC-SHA1, one round, as Linux Chromium's Safe Storage keys use. */
const PBKDF2 = Kdf.pbkdf2({ hash: Digest.sha1, iterations: 1 })
/** The fixed `v10` password on Linux. */
export const V10_PASSWORD = new TextEncoder().encode("peanuts")

/** `secret-tool`'s arguments for a browser's Safe Storage secret: each Chromium-family browser keeps its own, by name. */
export const secretToolArgs = (application: string): ReadonlyArray<string> => ["lookup", "application", application]

/** The `Cookies` database version (its `meta` row) from which Chrome puts the host_key's SHA-256 in front of each value. */
export const DIGEST_VERSION = 24

/** A 128-bit AES-CBC key from a Safe Storage secret. */
export const deriveKey = (kdf: Kdf.Kdf["Service"], secret: Uint8Array): Effect.Effect<Cipher.Key> =>
  kdf.derive(PBKDF2, secret, { salt: SALT, length: 16 }).pipe(
    Effect.flatMap((bytes) => Cipher.key(Cipher.aes128Cbc, bytes)),
    Effect.orDie,
  )

/** The 3-byte version prefix of an encrypted value (`v10`, `v11`, `v20`), or null when it has none. */
export const versionOf = (encrypted: Uint8Array): string | null => {
  if (encrypted.length < 3) return null
  const p = new TextDecoder().decode(encrypted.subarray(0, 3))
  return /^v\d\d$/u.test(p) ? p : null
}

/**
 * Decrypts a `v10`/`v11` cookie value with the already-derived `key`, strips the host_key digest Chrome 130+ prepends,
 * and returns the plaintext bytes. The caller passes the right key for the value's prefix. Null when it won't decrypt,
 * or (`requireDigest`, a database of `DIGEST_VERSION` or later) when the digest isn't there: a wrong key can pass the
 * padding check about one time in 256, and its garbage must not be sent.
 */
export const decryptValue = (
  cipher: Cipher.Cipher["Service"],
  digest: Digest.Digest["Service"],
  key: Cipher.Key,
  hostKey: string,
  encrypted: Uint8Array,
  requireDigest: boolean,
): Effect.Effect<Uint8Array | null> =>
  Effect.gen(function* () {
    const body = encrypted.subarray(3)
    if (body.length === 0 || body.length % 16 !== 0) return null
    const plain = yield* cipher.decrypt(key, body, { iv: IV }).pipe(Effect.option)
    if (plain._tag === "None") return null
    const value = plain.value
    const sum = yield* digest.digest(Digest.sha256, new TextEncoder().encode(hostKey))
    if (value.length >= 32 && sum.every((b, i) => b === value[i])) return value.subarray(32)
    return requireDigest ? null : value
  })
