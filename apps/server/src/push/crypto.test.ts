import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Aead, Kdf, KeyAgreement, KeyFormat, SecureRandom, Signature } from "effect/crypto"
import { createECDH, createPublicKey, verify } from "node:crypto"
import { decryptPush } from "@huntaway/testing"
import { authorization, b64, encrypt, encryptWith, isPublicKey, newVapid, unb64, vapidFrom } from "./crypto.ts"
import type { Crypto } from "./crypto.ts"

// The old push tests' encryption and VAPID cases (encryption_matches_the_rfc_8291_example,
// each_message_gets_its_own_key_and_salt, the_vapid_key_is_made_once_and_signs_tokens_for_the_push_service's signing
// half; the key kept once is in Push.test.ts).

const CryptoLive = Layer.mergeAll(KeyAgreement.layerWebCrypto, Kdf.layerWebCrypto, Aead.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
)

const services = Effect.gen(function* () {
  const c: Crypto = {
    agreement: yield* KeyAgreement.KeyAgreement,
    kdf: yield* Kdf.Kdf,
    aead: yield* Aead.Aead,
    signature: yield* Signature.Signature,
  }
  return c
})

const bytes = (s: string) => {
  const b = unb64(s)
  if (b === null) throw new Error(`not base64url: ${s}`)
  return b
}
const text = new TextEncoder()
const json = (s: string) => Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(Buffer.from(s, "base64url").toString())

/** A user agent's ECDH key from its private scalar (node:crypto, apart from the code under test). */
const keyFrom = (d: string) => {
  const k = createECDH("prime256v1")
  k.setPrivateKey(bytes(d))
  return k
}

describe("push crypto", () => {
  it.effect("encrypts as RFC 8291's example does, and the user agent's key reads it", () =>
    Effect.gen(function* () {
      const c = yield* services
      // RFC 8291, section 5 and appendix A.
      const asPublic = bytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
      const privateKey = yield* KeyFormat.decodePrivate(KeyFormat.jwk, KeyAgreement.ecdhP256, {
        kty: "EC",
        crv: "P-256",
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        x: b64(asPublic.subarray(1, 33)),
        y: b64(asPublic.subarray(33, 65)),
      })
      const salt = bytes("DGv6ra1nlYgDCS1FRnbzlw")
      const uaPublic = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
      const auth = bytes("BTBZMqHH6r4Tts7J_aSIgg")
      const body = yield* encryptWith(c, { privateKey, publicKey: asPublic }, salt, uaPublic, auth, text.encode("When I grow up, I want to be a watermelon"))
      assert.strictEqual(
        b64(body),
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95" +
          "bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      )
      assert.strictEqual(decryptPush(keyFrom("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), auth, body), "When I grow up, I want to be a watermelon")
    }).pipe(Effect.provide(CryptoLive)),
  )

  it.effect("gives each message its own key and salt, and refuses one too long or a key that isn't one", () =>
    Effect.gen(function* () {
      const c = yield* services
      const ua = createECDH("prime256v1")
      ua.generateKeys()
      const auth = new Uint8Array(16).fill(7)
      const random = yield* SecureRandom.SecureRandom
      const a = yield* encrypt(c, yield* random.randomBytes(16), ua.getPublicKey(), auth, text.encode("hello"))
      const b = yield* encrypt(c, yield* random.randomBytes(16), ua.getPublicKey(), auth, text.encode("hello"))
      assert.notStrictEqual(b64(a.subarray(0, 86)), b64(b.subarray(0, 86)))
      assert.strictEqual(decryptPush(ua, auth, a), "hello")
      assert.strictEqual(decryptPush(ua, auth, b), "hello")
      const salt = yield* random.randomBytes(16)
      const long = yield* Effect.flip(encrypt(c, salt, ua.getPublicKey(), auth, new Uint8Array(4000).fill(120)))
      assert.strictEqual(long.reason, "the message is too long to push")
      const notAKey = yield* Effect.flip(encrypt(c, salt, new Uint8Array(65).fill(4), auth, text.encode("hello")))
      assert.strictEqual(notAKey.reason, "the subscription's key isn't a P-256 public key")
      assert.isTrue(yield* isPublicKey(c, ua.getPublicKey()))
      assert.isFalse(yield* isPublicKey(c, new Uint8Array(65).fill(4)))
      assert.isFalse(yield* isPublicKey(c, ua.getPublicKey().subarray(1)))
    }).pipe(Effect.provide(CryptoLive)),
  )

  it.effect("signs a token for the push service's origin, valid for 12 hours", () =>
    Effect.gen(function* () {
      const c = yield* services
      const vapid = yield* vapidFrom(yield* newVapid(c))
      assert.strictEqual(vapid.publicKey.length, 65)
      const header = yield* authorization(c, vapid, "https://fcm.googleapis.com/fcm/send/abc:def", "mailto:me@example.com", 1_000_000)
      assert.isTrue(header.startsWith("vapid t="))
      const [t = "", k = ""] = header.slice("vapid t=".length).split(", k=")
      assert.strictEqual(k, b64(vapid.publicKey))
      const [h = "", claims = "", sig = ""] = t.split(".")
      assert.deepStrictEqual(yield* json(h), { typ: "JWT", alg: "ES256" })
      assert.deepStrictEqual(yield* json(claims), { aud: "https://fcm.googleapis.com", exp: 1_000_000 + 12 * 3600, sub: "mailto:me@example.com" })
      const pub = bytes(k)
      const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: "jwk" })
      assert.isTrue(verify("sha256", Buffer.from(`${h}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, bytes(sig)))
      assert.isFalse(verify("sha256", Buffer.from("something else"), { key, dsaEncoding: "ieee-p1363" }, bytes(sig)))
      assert.strictEqual((yield* Effect.flip(authorization(c, vapid, "not a url", "x", 0))).reason, "the endpoint isn't a URL")
    }).pipe(Effect.provide(CryptoLive)),
  )
})
