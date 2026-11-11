import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClient } from "effect/http"
import { readClient, SCOPES } from "../assistant/googleText.ts"
import { idToken } from "../assistant/googleText.test.ts"
import { challenge, signIn, writePrivate } from "./googleAuth.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// `huntaway google-auth`'s flow (the old agent/assistant/google/tests.test.ts, its consent half): against a token
// endpoint of the test's own (never Google's), with the test as the browser.

const mode = (p: string) => statSync(p).mode & 0o777

/** A token endpoint like Google's: it takes `the-code` (with a PKCE verifier) for the flow's tokens. Its URL and the forms it was sent. */
const fakeGoogle = Effect.gen(function* () {
  const seen: Array<URLSearchParams> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d.toString()))
    req.on("end", () => {
      const form = new URLSearchParams(body)
      seen.push(form)
      const ok =
        req.url === "/token" && form.get("grant_type") === "authorization_code" && form.get("code") === "the-code" && (form.get("code_verifier") ?? "") !== ""
      res.setHeader("content-type", "application/json")
      if (!ok) {
        res.statusCode = 400
        res.end(json({ error: "invalid_grant", error_description: "Bad code." }))
        return
      }
      const scope = SCOPES.filter((s) => !s.includes("drive")).join(" ")
      res.end(json({ access_token: "at", expires_in: 3599, refresh_token: "rt", scope, id_token: idToken("sam@example.com") }))
    })
  })
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address()
        resume(Effect.succeed(typeof a === "object" && a !== null ? a.port : 0))
      })
    }),
    () => Effect.sync(() => server.close()),
  )
  return { uri: `http://127.0.0.1:${port}/token`, seen }
})

const services = Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto, Digest.layerWebCrypto, NodeServices.layer)
const listening = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })

/** Signs in with the test as the browser: `browse` is given the consent URL and the redirect. */
const flow = <E>(token: string, dir: string, browse: (url: string, redirect: string) => Effect.Effect<void, E, HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const client = Result.getOrThrow(readClient(json({ installed: { client_id: "id", client_secret: "shh", token_uri: token } })))
    const shown = yield* Deferred.make<readonly [string, string]>()
    const signing = yield* signIn(client, dir, (url, redirect) => Deferred.succeed(shown, [url, redirect]).pipe(Effect.asVoid)).pipe(
      Effect.provide(listening),
      Effect.scoped,
      Effect.result,
      Effect.forkChild,
    )
    const [url, redirect] = yield* Deferred.await(shown)
    yield* browse(url, redirect).pipe(Effect.orDie)
    return yield* Fiber.join(signing)
  })

const get = (url: string) =>
  Effect.flatMap(HttpClient.HttpClient, (c) => c.get(url)).pipe(Effect.flatMap((r) => Effect.map(r.text, (text) => ({ status: r.status, text }))))

describe("google-auth", () => {
  it.effect("PKCE's challenge is RFC 7636's", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }).pipe(Effect.provide(Digest.layerWebCrypto)),
  )

  it.live("signing in takes the browser's code to the token endpoint and keeps the tokens, for the user alone", () =>
    Effect.gen(function* () {
      const google = yield* fakeGoogle
      const dir = `${mkdtempSync(`${tmpdir()}/huntaway-google-`)}/credentials`
      const done = yield* flow(google.uri, dir, (url, redirect) =>
        Effect.gen(function* () {
          const state = new URLSearchParams(url.split("?")[1]).get("state")
          // A stray request first, then another flow's answer: neither ends it.
          assert.strictEqual((yield* get(`${redirect}favicon.ico`)).status, 404)
          assert.strictEqual((yield* get(`${redirect}?state=nope&code=the-code`)).status, 404)
          assert.include((yield* get(`${redirect}?state=${state}&code=the-code`)).text, "Signed in")
        }),
      )
      const signed = Result.getOrThrow(done)
      assert.strictEqual(signed.email, "sam@example.com")
      assert.strictEqual(signed.file, `${dir}/sam@example.com.json`)
      // Drive was left unticked.
      assert.isTrue(signed.missing.length === 3 && signed.missing.every((s) => s.includes("drive")), json(signed.missing))
      const form = google.seen[0]
      assert.isTrue((form?.get("redirect_uri") ?? "").startsWith("http://127.0.0.1:") && form?.get("client_secret") === "shh")
      const v = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ refresh_token: Schema.String, token_uri: Schema.String })))(
        readFileSync(signed.file, "utf8"),
      )
      assert.deepStrictEqual([v.refresh_token, v.token_uri], ["rt", google.uri])
      assert.strictEqual(mode(signed.file), 0o600)
      assert.strictEqual(mode(dir), 0o700)
    }).pipe(Effect.provide(services), Effect.scoped),
  )

  it.live("a denied consent ends the flow and says so", () =>
    Effect.gen(function* () {
      const google = yield* fakeGoogle
      const dir = mkdtempSync(`${tmpdir()}/huntaway-google-`)
      const done = yield* flow(google.uri, dir, (url, redirect) =>
        Effect.asVoid(get(`${redirect}?state=${new URLSearchParams(url.split("?")[1]).get("state")}&error=access_denied`)),
      )
      assert.isTrue(Result.isFailure(done) && json(done.failure).includes("access_denied"), json(done))
      assert.deepStrictEqual(readdirSync(dir), [])
    }).pipe(Effect.provide(services), Effect.scoped),
  )

  it.live("a file written over stays private, with nothing left beside it", () =>
    Effect.gen(function* () {
      const file = `${mkdtempSync(`${tmpdir()}/huntaway-google-`)}/new/credentials/sam@example.com.json`
      yield* writePrivate(file, "{}")
      assert.strictEqual(mode(file), 0o600)
      chmodSync(file, 0o644)
      writeFileSync(file, "old")
      yield* writePrivate(file, '{"a":1}')
      assert.strictEqual(mode(file), 0o600)
      assert.strictEqual(readFileSync(file, "utf8"), '{"a":1}')
      assert.strictEqual(readdirSync(file.slice(0, file.lastIndexOf("/"))).length, 1)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
