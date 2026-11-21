import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { TestPlatform } from "@huntaway/testing"
import { acceptsEncoding, StaticUi } from "./routes.ts"

// The built UI's precompressed files (HE-71): the build writes `.br` and `.gz` beside each text file, and the server
// sends the one the browser accepts, as the file's own type, with its own ETag.

const script = `console.log("${"the board ".repeat(400)}")\n`
const ui = mkdtempSync(`${tmpdir()}/huntaway-ui-`)
mkdirSync(`${ui}/assets`)
writeFileSync(`${ui}/index.html`, "<!doctype html><title>Huntaway</title>")
writeFileSync(`${ui}/assets/index-abc.js`, script)
writeFileSync(`${ui}/assets/index-abc.js.br`, brotliCompressSync(script))
writeFileSync(`${ui}/assets/index-abc.js.gz`, gzipSync(script))
// A file the build left alone (too small to gain): served as it is whatever the browser accepts.
writeFileSync(`${ui}/assets/small-abc.js`, "export {}\n")

const served = HttpRouter.serve(StaticUi, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(TestPlatform({ uiDir: ui })),
)

const get = (path: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const r = yield* (yield* HttpClient.HttpClient).execute(HttpClientRequest.get(path, { headers }))
    // The client decodes the body as a browser does, so `text` is the file whichever encoding came.
    return { status: r.status, headers: r.headers, text: yield* r.text }
  })

describe("the UI's precompressed files", () => {
  it.effect("sends brotli, then gzip, as the file's own type, and the file itself to a browser that takes neither", () =>
    Effect.gen(function* () {
      const br = yield* get("/assets/index-abc.js", { "accept-encoding": "gzip, deflate, br" })
      assert.strictEqual(br.status, 200)
      assert.strictEqual(br.headers["content-encoding"], "br")
      assert.strictEqual(br.headers["content-type"], "text/javascript; charset=utf-8")
      assert.strictEqual(br.headers["vary"], "Accept-Encoding")
      assert.strictEqual(br.headers["cache-control"], "public, max-age=31536000, immutable")
      assert.strictEqual(br.text, script)

      const gz = yield* get("/assets/index-abc.js", { "accept-encoding": "br;q=0, gzip" })
      assert.strictEqual(gz.headers["content-encoding"], "gzip")
      assert.strictEqual(gz.headers["content-type"], "text/javascript; charset=utf-8")
      assert.strictEqual(gz.text, script)

      const raw = yield* get("/assets/index-abc.js", { "accept-encoding": "identity" })
      assert.strictEqual(raw.headers["content-encoding"], undefined)
      assert.strictEqual(raw.headers["vary"], "Accept-Encoding")
      assert.strictEqual(raw.headers["content-length"], String(script.length))
      assert.strictEqual(raw.text, script)

      // Each encoding is its own representation, with its own tag.
      const tags = new Set([br.headers["etag"], gz.headers["etag"], raw.headers["etag"]])
      assert.strictEqual(tags.size, 3)
    }).pipe(Effect.provide(served)),
  )

  it.effect("answers 304 only for the tag of the encoding it would send", () =>
    Effect.gen(function* () {
      const br = yield* get("/assets/index-abc.js", { "accept-encoding": "br" })
      const tag = br.headers["etag"] ?? ""
      const again = yield* get("/assets/index-abc.js", { "accept-encoding": "br", "if-none-match": tag })
      assert.strictEqual(again.status, 304)
      assert.strictEqual(again.headers["vary"], "Accept-Encoding")
      const other = yield* get("/assets/index-abc.js", { "accept-encoding": "identity", "if-none-match": tag })
      assert.strictEqual(other.status, 200)
      assert.strictEqual(other.headers["content-encoding"], undefined)
    }).pipe(Effect.provide(served)),
  )

  it.effect("falls back to the file where the build wrote no variant, and keeps the page's fallback", () =>
    Effect.gen(function* () {
      const small = yield* get("/assets/small-abc.js", { "accept-encoding": "br, gzip" })
      assert.strictEqual(small.status, 200)
      assert.strictEqual(small.headers["content-encoding"], undefined)
      assert.strictEqual(small.text, "export {}\n")

      const page = yield* get("/board/p1", { accept: "text/html", "accept-encoding": "br, gzip" })
      assert.strictEqual(page.status, 200)
      assert.strictEqual(page.headers["cache-control"], "no-cache")
      assert.include(page.text, "<title>Huntaway</title>")

      assert.strictEqual((yield* get("/assets/missing.js", { "accept-encoding": "br" })).status, 404)
    }).pipe(Effect.provide(served)),
  )

  it("reads Accept-Encoding's q-values and wildcard", () => {
    assert.isTrue(acceptsEncoding("gzip, deflate, br", "br"))
    assert.isTrue(acceptsEncoding("BR;Q=0.5", "br"))
    assert.isFalse(acceptsEncoding("br;q=0, gzip", "br"))
    assert.isTrue(acceptsEncoding("*", "gzip"))
    assert.isFalse(acceptsEncoding("*;q=0", "gzip"))
    assert.isFalse(acceptsEncoding("gzip;q=0, *", "gzip"))
    assert.isFalse(acceptsEncoding("identity", "br"))
    assert.isFalse(acceptsEncoding(undefined, "br"))
  })
})
