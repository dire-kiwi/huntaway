import { Effect, Option, Queue, Schema } from "effect"
import type { Scope } from "effect"
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto"
import type { ECDH } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingHttpHeaders } from "node:http"

// A push service on this machine for tests (docs/plan/10-testing.md, packages/testing): no test reaches a real one. It
// takes what the board posts to it and answers with the status a test sets; a device's keys read what it was sent, as
// a browser would (RFC 8291 the other way round, on node:crypto, apart from the board's own code).

/** A push the service got. */
export interface Got {
  /** The endpoint's path: which device it was for. */
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: Uint8Array
}

export interface FakePushService {
  /** The URL of device `name`'s subscription. */
  readonly endpoint: (name: string) => string
  /** The next push it got, waiting for one. */
  readonly next: Effect.Effect<Got>
  /** The pushes it got and nobody took yet. */
  readonly waiting: Effect.Effect<ReadonlyArray<Got>>
  /** What it answers from now on (201 to start with). */
  readonly answer: (status: number) => Effect.Effect<void>
}

/** A push service on 127.0.0.1, stopped with the scope. */
export const fakePushService: Effect.Effect<FakePushService, never, Scope.Scope> = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Got>()
  // The answer is read when a request ends, outside any fiber: a plain cell, kept in step with `status`.
  const current = { code: 201 }
  const server = createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      Queue.offerUnsafe(queue, { path: req.url ?? "/", headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) })
      res.writeHead(current.code).end()
    })
  })
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0))
      })
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      }),
  )
  return {
    endpoint: (name) => `http://127.0.0.1:${port}/push/${name}`,
    next: Queue.take(queue),
    waiting: Queue.clear(queue),
    answer: (code) =>
      Effect.sync(() => {
        current.code = code
      }),
  }
})

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url")

/** What a push carries, as the service worker reads it. */
export const PushMessage = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  tag: Schema.String,
  task_id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  request_id: Schema.optional(Schema.String),
})
export type PushMessage = typeof PushMessage.Type

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PushMessage))

/** A browser's side of a subscription: its keys, and reading what it's pushed. */
export interface PushDeviceKeys {
  /** As `PushSubscription.toJSON().keys` gives them. */
  readonly keys: { readonly p256dh: string; readonly auth: string }
  /** The text of a push for this device (RFC 8291 section 3.4); throws if it isn't one. */
  readonly decrypt: (body: Uint8Array) => string
  /** A push's message; throws if it isn't one. */
  readonly read: (body: Uint8Array) => PushMessage
}

/** What a browser does with a push it gets: RFC 8291 the other way round. */
export const decryptPush = (ua: ECDH, auth: Uint8Array, body: Uint8Array): string => {
  const buf = Buffer.from(body)
  const salt = buf.subarray(0, 16)
  if (buf.readUInt32BE(16) !== 4096) throw new Error("not one 4096-byte record")
  const idlen = buf[20] ?? 0
  const asPublic = buf.subarray(21, 21 + idlen)
  const sealed = buf.subarray(21 + idlen)
  const secret = ua.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12))
  const d = createDecipheriv("aes-128-gcm", cek, nonce)
  d.setAuthTag(sealed.subarray(-16))
  const plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()])
  // The last record ends in 2, then any padding of zeros.
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) end--
  if (plain[end - 1] !== 2) throw new Error("no last record's delimiter")
  return plain.subarray(0, end - 1).toString()
}

/** A new device's keys, as its browser makes them. */
export const pushDevice = (): PushDeviceKeys => {
  const ua = createECDH("prime256v1")
  ua.generateKeys()
  const auth = randomBytes(16)
  const decrypt = (body: Uint8Array) => decryptPush(ua, auth, body)
  return {
    keys: { p256dh: b64(ua.getPublicKey()), auth: b64(auth) },
    decrypt,
    read: (body) => Option.getOrThrowWith(decodeMessage(decrypt(body)), () => new Error("a push that isn't a message")),
  }
}
