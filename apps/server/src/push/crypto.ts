import { Effect, Result, Schema } from "effect"
import type { CryptoError } from "effect/crypto"
import { Aead, Kdf, KeyAgreement, KeyFormat, Signature } from "effect/crypto"
import { Base64Url } from "effect/encoding"

// Web Push's cryptography (the old push/webpush.ts) on `effect/crypto`: encrypting a message for a subscription
// (RFC 8291, `aes128gcm` of RFC 8188) and signing a push with the board's VAPID key (RFC 8292). The services are passed
// in, as the `WebPush` layer takes them once.

/** The services this needs. */
export interface Crypto {
  readonly agreement: KeyAgreement.KeyAgreement["Service"]
  readonly kdf: Kdf.Kdf["Service"]
  readonly aead: Aead.Aead["Service"]
  readonly signature: Signature.Signature["Service"]
}

/** Why a message couldn't be encrypted or signed: bounded, shown as a device's `last_error`. */
export class PushCryptoFailed extends Schema.TaggedError<PushCryptoFailed, { readonly brand: unique symbol }>()("PushCryptoFailed", {
  reason: Schema.String,
}) {}

const failed = (reason: string) => (): PushCryptoFailed => new PushCryptoFailed({ reason })

export const b64 = (bytes: Uint8Array): string => Base64Url.encode(bytes)

/** URL-safe base64, padding allowed (browsers send none, some libraries add it); null for anything else. */
export const unb64 = (text: string): Uint8Array | null => {
  const s = text.replace(/=+$/, "")
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  return Result.getOrNull(Base64Url.decode(s))
}

const utf8 = new TextEncoder()
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------- the VAPID key ----------

/** The board's VAPID key as kept (`Secrets`' `vapid_key`): a P-256 JWK's private scalar and public point, base64url. */
export const VapidJwk = Schema.Struct({ d: Schema.String, x: Schema.String, y: Schema.String })
export type VapidJwk = typeof VapidJwk.Type
export const VapidJson = Schema.fromJsonString(VapidJwk)

/** The board's VAPID key: pushes are signed with it, and browsers subscribe with its public point. */
export interface Vapid {
  readonly key: Signature.PrivateKey<Signature.Ecdsa<"P-256">>
  /** The public key as browsers take it (`applicationServerKey`): an uncompressed point, 65 bytes. */
  readonly publicKey: Uint8Array
}

/** The uncompressed point of a JWK's `x` and `y`. */
const point = (jwk: VapidJwk): Uint8Array | null => {
  const x = unb64(jwk.x)
  const y = unb64(jwk.y)
  return x === null || y === null || x.length !== 32 || y.length !== 32 ? null : concat(Uint8Array.of(4), x, y)
}

/** The key from its JWK. */
export const vapidFrom = (jwk: VapidJwk): Effect.Effect<Vapid, PushCryptoFailed> =>
  Effect.gen(function* () {
    const publicKey = point(jwk)
    if (publicKey === null) return yield* new PushCryptoFailed({ reason: "the VAPID key isn't a P-256 key" })
    const key = yield* KeyFormat.decodePrivate(KeyFormat.jwk, Signature.ecdsaP256, { kty: "EC", crv: "P-256", ...jwk }).pipe(
      Effect.mapError(failed("the VAPID key isn't a P-256 key")),
    )
    return { key, publicKey }
  })

/** A new VAPID key's JWK. */
export const newVapid = (c: Crypto): Effect.Effect<VapidJwk, PushCryptoFailed> =>
  Effect.gen(function* () {
    const pair = yield* c.signature.generateKeyPair(Signature.ecdsaP256).pipe(Effect.mapError(failed("couldn't make a VAPID key")))
    const jwk = yield* KeyFormat.encode(KeyFormat.jwk, pair.privateKey).pipe(Effect.mapError(failed("couldn't keep the VAPID key")))
    if (jwk.d === undefined || jwk.x === undefined || jwk.y === undefined) return yield* new PushCryptoFailed({ reason: "couldn't keep the VAPID key" })
    return { d: jwk.d, x: jwk.x, y: jwk.y }
  })

// ---------- encryption (RFC 8291) ----------

/** The size of the one record a push message is (RFC 8188's `rs`), which is at most 4096. */
export const RECORD_SIZE = 4096

/** The content encryption key and nonce of a message with `salt`, for the subscription's key and auth secret (RFC 8291 3.3, 3.4). */
export const contentKeys = (
  c: Crypto,
  secret: Uint8Array,
  auth: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Effect.Effect<{ readonly cek: Uint8Array; readonly nonce: Uint8Array }, CryptoError.CryptoError> =>
  Effect.gen(function* () {
    // IKM = HKDF(auth secret, ECDH secret, "WebPush: info" 0 ua_public as_public), then the key and nonce from the salt.
    const ikm = yield* c.kdf.derive(Kdf.hkdfSha256, secret, { salt: auth, info: concat(utf8.encode("WebPush: info\0"), uaPublic, asPublic), length: 32 })
    const cek = yield* c.kdf.derive(Kdf.hkdfSha256, ikm, { salt, info: utf8.encode("Content-Encoding: aes128gcm\0"), length: 16 })
    const nonce = yield* c.kdf.derive(Kdf.hkdfSha256, ikm, { salt, info: utf8.encode("Content-Encoding: nonce\0"), length: 12 })
    return { cek, nonce }
  })

/** The sender's one-off ECDH key for a message (RFC 8291's application server key pair). */
export interface SenderKey {
  readonly privateKey: KeyAgreement.PrivateKey<KeyAgreement.Ecdh<"P-256">>
  readonly publicKey: Uint8Array
}

/**
 * `plaintext` encrypted with sender key `as` and `salt` for a subscription's public key (`p256dh`, an uncompressed
 * point) and auth secret: the body of the push request (`Content-Encoding: aes128gcm`).
 */
export const encryptWith = (
  c: Crypto,
  as: SenderKey,
  salt: Uint8Array,
  uaPublic: Uint8Array,
  auth: Uint8Array,
  plaintext: Uint8Array,
): Effect.Effect<Uint8Array, PushCryptoFailed> =>
  Effect.gen(function* () {
    // One record, the last: the text and its padding delimiter (2), and no padding.
    if (plaintext.length + 1 + 16 > RECORD_SIZE - 86) return yield* new PushCryptoFailed({ reason: "the message is too long to push" })
    const peer = yield* KeyAgreement.publicKey(KeyAgreement.ecdhP256, uaPublic).pipe(Effect.mapError(failed("the subscription's key isn't a P-256 public key")))
    const secret = yield* c.agreement.deriveSharedSecret(as.privateKey, peer).pipe(Effect.mapError(failed("the subscription's key isn't a P-256 public key")))
    const { cek, nonce } = yield* contentKeys(c, secret, auth, uaPublic, as.publicKey, salt).pipe(Effect.mapError(failed("couldn't derive the message's key")))
    const key = yield* Aead.key(Aead.aes128Gcm, cek).pipe(Effect.mapError(failed("couldn't derive the message's key")))
    const sealed = yield* c.aead.encrypt(key, concat(plaintext, Uint8Array.of(2)), { nonce }).pipe(Effect.mapError(failed("couldn't encrypt the message")))
    // salt, record size, the sender's public key as the key id, then the record.
    const rs = new Uint8Array(4)
    new DataView(rs.buffer).setUint32(0, RECORD_SIZE)
    return concat(salt, rs, Uint8Array.of(as.publicKey.length), as.publicKey, sealed)
  })

/** `encryptWith` a new sender key and a random salt: each message gets its own. */
export const encrypt = (
  c: Crypto,
  salt: Uint8Array,
  uaPublic: Uint8Array,
  auth: Uint8Array,
  plaintext: Uint8Array,
): Effect.Effect<Uint8Array, PushCryptoFailed> =>
  Effect.gen(function* () {
    const pair = yield* c.agreement.generateKeyPair(KeyAgreement.ecdhP256).pipe(Effect.mapError(failed("couldn't make the message's key")))
    const publicKey = yield* KeyAgreement.toBytes(pair.publicKey).pipe(Effect.mapError(failed("couldn't make the message's key")))
    return yield* encryptWith(c, { privateKey: pair.privateKey, publicKey }, salt, uaPublic, auth, plaintext)
  })

/** Whether `bytes` is a P-256 public key (an uncompressed point on the curve), as a subscription's `p256dh` must be. */
export const isPublicKey = (c: Crypto, bytes: Uint8Array): Effect.Effect<boolean> =>
  bytes.length !== 65
    ? Effect.succeed(false)
    : Effect.gen(function* () {
        const pair = yield* c.agreement.generateKeyPair(KeyAgreement.ecdhP256)
        const peer = yield* KeyAgreement.publicKey(KeyAgreement.ecdhP256, bytes)
        yield* c.agreement.deriveSharedSecret(pair.privateKey, peer)
        return true
      }).pipe(Effect.orElseSucceed(() => false))

// ---------- VAPID (RFC 8292) ----------

const ClaimsJson = Schema.fromJsonString(Schema.Struct({ aud: Schema.String, exp: Schema.Int, sub: Schema.String }))
const HEADER = b64(utf8.encode('{"typ":"JWT","alg":"ES256"}'))

/**
 * The `Authorization` header for a push to `endpoint`: a token signed with the board's key, for the push service's
 * origin, valid for 12 hours from `now` (a Unix time in seconds), naming `sub` (who runs the board) for push services
 * to contact.
 */
export const authorization = (c: Crypto, vapid: Vapid, endpoint: string, sub: string, now: number): Effect.Effect<string, PushCryptoFailed> =>
  Effect.gen(function* () {
    const url = URL.parse(endpoint)
    if (url === null) return yield* new PushCryptoFailed({ reason: "the endpoint isn't a URL" })
    const claims = yield* Schema.encodeEffect(ClaimsJson)({ aud: url.origin, exp: now + 12 * 3600, sub }).pipe(
      Effect.mapError(() => new PushCryptoFailed({ reason: "couldn't write the VAPID claims" })),
    )
    const signed = `${HEADER}.${b64(utf8.encode(claims))}`
    // ES256: ECDSA's raw `r‖s`, as `Signature` gives it.
    const sig = yield* c.signature.sign(vapid.key, utf8.encode(signed)).pipe(Effect.mapError(failed("couldn't sign the push")))
    return `vapid t=${signed}.${b64(sig)}, k=${b64(vapid.publicKey)}`
  })
