import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { fakeSocks, hostEcho } from "@huntaway/testing"
import { checkSocksProxy, chromeProxyArgs, isLoopback, proxiedTo, socksClient } from "./socks.ts"

// HE-67: the host's SOCKS proxy: what the setting takes, which pages go through it, and a request that does.

describe("the SOCKS proxy", () => {
  it.effect("is stored as socks5://host:port; blank is none; anything else is refused", () =>
    Effect.gen(function* () {
      const ok: ReadonlyArray<readonly [string, string | null]> = [
        [" socks5://127.0.0.1:1080 ", "socks5://127.0.0.1:1080"],
        ["socks5h://proxy.lan:9050", "socks5://proxy.lan:9050"],
        ["socks://proxy.lan", "socks5://proxy.lan:1080"],
        ["socks5://[::1]:1080/", "socks5://[::1]:1080"],
        ["  ", null],
      ]
      for (const [given, stored] of ok) assert.strictEqual(yield* checkSocksProxy(given), stored, given)
      for (const bad of ["127.0.0.1:1080", "http://proxy:3128", "socks4://proxy:1080", "socks5://me:pw@proxy:1080", "socks5://proxy:1080/x", "socks5://"]) {
        const e = yield* Effect.flip(checkSocksProxy(bad))
        assert.strictEqual(e.field, "socks_proxy", bad)
      }
    }),
  )

  it("leaves this machine's pages out", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) assert.isTrue(isLoopback(h), h)
    for (const h of ["preview.example", "10.0.0.5", "localhost.example", "128.0.0.1"]) assert.isFalse(isLoopback(h), h)
    assert.isTrue(proxiedTo("socks5://p:1080", "https://pr-3.preview.example/"))
    assert.isFalse(proxiedTo("socks5://p:1080", "http://localhost:5173/"))
    assert.isFalse(proxiedTo(null, "https://pr-3.preview.example/"))
    assert.deepStrictEqual([chromeProxyArgs(null), chromeProxyArgs("socks5://p:1080")], [[], ["--proxy-server=socks5://p:1080"]])
  })

  it.effect("sends a request through it, with the page's name resolved at the proxy", () =>
    Effect.gen(function* () {
      const site = yield* hostEcho
      const proxy = yield* fakeSocks(site.port)
      const client = yield* socksClient(proxy.url)
      const res = yield* client.execute(HttpClientRequest.get("http://preview.test:8080/pr/3"))
      assert.deepStrictEqual([res.status, yield* res.text], [200, "<title>preview.test:8080</title>"])
      assert.deepStrictEqual(proxy.asked, ["preview.test:8080"])
    }).pipe(Effect.scoped),
  )
})
