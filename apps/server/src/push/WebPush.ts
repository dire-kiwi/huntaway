import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Aead, Digest, Kdf, KeyAgreement, SecureRandom, Signature } from "effect/crypto"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Secrets } from "../platform/Secrets.ts"
import { authorization, b64, encrypt, isPublicKey, newVapid, unb64, VapidJson, vapidFrom } from "./crypto.ts"
import type { Crypto, Vapid } from "./crypto.ts"
import type { PushEvent } from "./rules.ts"

// Web Push itself (the old push/webpush.ts and the sending half of push/subscriptions.ts): the board's VAPID key, and
// one message delivered to one browser's push service, encrypted for it (RFC 8291) and signed (RFC 8292).

/** Where the board's VAPID key is kept (`Secrets`), made the first time it's needed. */
export const VAPID_SECRET = "vapid_key"

/**
 * Who runs the board, for push services to contact (RFC 8292's `sub`); Apple's turns away a token without one. The old
 * `IA_PUSH_SUBJECT` that changed it isn't carried (docs/plan/06-server.md, As built in 6.8).
 */
export const SUBJECT = "https://github.com/dire-kiwi/huntaway"

/** How long a push service has to answer. */
export const PUSH_TIMEOUT = "30 seconds"

/**
 * What a push says: the notification's title and text, the page tapping it opens, and its tag (a task's notification
 * replaces the one before it). `task_id`, `event` and `request_id` are left out when there are none.
 */
export interface Message {
  readonly title: string
  readonly body: string
  readonly url: string
  readonly tag: string
  readonly task_id?: string
  readonly event?: PushEvent
  readonly request_id?: string
}

const MessageJson = Schema.fromJsonString(
  Schema.Struct({
    title: Schema.String,
    body: Schema.String,
    url: Schema.String,
    tag: Schema.String,
    task_id: Schema.optional(Schema.String),
    event: Schema.optional(Schema.String),
    request_id: Schema.optional(Schema.String),
  }),
)

/** Why a push wasn't delivered: `gone` when the push service no longer has the subscription. */
export interface Undelivered {
  readonly gone: boolean
  readonly error: string
}

/** Where a push goes: a browser's subscription (its keys base64url). */
export interface Target {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

export interface WebPushShape {
  /** The board's public key, for browsers to subscribe with (base64url of the uncompressed point). */
  readonly publicKey: Effect.Effect<string>
  /** A browser's keys, checked (a P-256 public key and a 16-byte auth secret) and written without padding; null if they aren't. */
  readonly checkKeys: (keys: { readonly p256dh: string; readonly auth: string }) => Effect.Effect<{ readonly p256dh: string; readonly auth: string } | null>
  /** Sends `message` to `target`; null once its push service took it. */
  readonly deliver: (target: Target, message: Message, urgent: boolean) => Effect.Effect<Undelivered | null>
}

const utf8 = new TextEncoder()
const failed = (error: string): Undelivered => ({ gone: false, error })

export class WebPush extends Context.Service<WebPush, WebPushShape>()("huntaway-server/push/WebPush") {
  static readonly layer = Layer.effect(
    WebPush,
    Effect.gen(function* () {
      const secrets = yield* Secrets
      const http = yield* HttpClient.HttpClient
      const random = yield* SecureRandom.SecureRandom
      const digest = yield* Digest.Digest
      const crypto: Crypto = {
        agreement: yield* KeyAgreement.KeyAgreement,
        kdf: yield* Kdf.Kdf,
        aead: yield* Aead.Aead,
        signature: yield* Signature.Signature,
      }
      const loaded = yield* Ref.make(Option.none<Vapid>())

      /** The board's key, made and kept the first time. One that doesn't read is a defect: the stored key was changed by hand. */
      const vapid = Effect.gen(function* () {
        const cached = yield* Ref.get(loaded)
        if (Option.isSome(cached)) return cached.value
        const made = newVapid(crypto).pipe(Effect.flatMap(Schema.encodeEffect(VapidJson)), Effect.orDie)
        const text = Redacted.value(yield* secrets.getOrMake(VAPID_SECRET, made))
        const jwk = yield* Schema.decodeEffect(VapidJson)(text).pipe(Effect.orDie)
        const key = yield* vapidFrom(jwk).pipe(Effect.orDie)
        yield* Ref.set(loaded, Option.some(key))
        return key
      })

      const checkKeys = Effect.fnUntraced(function* (keys: { readonly p256dh: string; readonly auth: string }) {
        const pub = unb64(keys.p256dh)
        const secret = unb64(keys.auth)
        if (pub === null || secret === null || secret.length !== 16 || !(yield* isPublicKey(crypto, pub))) return null
        return { p256dh: b64(pub), auth: b64(secret) }
      })

      const deliver = Effect.fn("WebPush.deliver")(function* (target: Target, message: Message, urgent: boolean) {
        const pub = unb64(target.p256dh)
        const secret = unb64(target.auth)
        if (pub === null || secret === null) return failed("the subscription's keys don't read")
        const text = yield* Schema.encodeEffect(MessageJson)(message).pipe(Effect.orDie)
        const salt = yield* random.randomBytes(16).pipe(Effect.orDie)
        const sealed = yield* Effect.result(encrypt(crypto, salt, pub, secret, utf8.encode(text)))
        if (sealed._tag === "Failure") return failed(sealed.failure.reason)
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        const auth = yield* Effect.result(authorization(crypto, yield* vapid, target.endpoint, SUBJECT, now))
        if (auth._tag === "Failure") return failed(auth.failure.reason)
        // A newer message about the same task replaces one still waiting to be delivered.
        const topic = (yield* digest.digestHex(Digest.sha256, utf8.encode(message.tag))).slice(0, 32)
        const request = HttpClientRequest.post(target.endpoint).pipe(
          HttpClientRequest.setHeaders({
            authorization: auth.success,
            "content-encoding": "aes128gcm",
            // Kept for a day while the device is offline.
            ttl: "86400",
            urgency: urgent ? "high" : "normal",
            topic,
          }),
          HttpClientRequest.bodyUint8Array(sealed.success, "application/octet-stream"),
        )
        const answered = yield* http.execute(request).pipe(
          Effect.flatMap((res) =>
            Effect.map(res.text.pipe(Effect.orElseSucceed(() => "")), (body) => ({ status: res.status, body: Array.from(body).slice(0, 300).join("").trim() })),
          ),
          Effect.timeoutOrElse({ duration: PUSH_TIMEOUT, orElse: () => Effect.fail("timed out") }),
          Effect.result,
        )
        if (answered._tag === "Failure") {
          const why = typeof answered.failure === "string" ? answered.failure : answered.failure.message
          return failed(`couldn't reach the push service: ${why}`)
        }
        const { status, body } = answered.success
        if (status >= 200 && status < 300) return null
        return { gone: status === 404 || status === 410, error: `the push service answered ${status}${body ? `: ${body}` : ""}` }
      })

      return WebPush.of({ publicKey: Effect.map(vapid, (v) => b64(v.publicKey)), checkKeys, deliver })
    }),
  )
}
