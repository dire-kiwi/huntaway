import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { fakeSpacePort, TestPlatform } from "@huntaway/testing"
import { Spaces } from "../spaces/Spaces.ts"
import { SpacesRoute } from "./spaces.ts"

// The Space relay (HE-35), against a stand-in for whatever answers on a Space's port: it is the Space's to choose, so the
// relay must never follow it anywhere, and always sandboxes what it passes on.

/** The port ticket `tk` opens, set by each test once its fake is listening. */
const target = { port: 0 }

const FakeSpaces = Layer.succeed(
  Spaces,
  Spaces.of({
    status: Effect.die("not in this test"),
    create: () => Effect.die("not in this test"),
    start: () => Effect.die("not in this test"),
    stop: () => Effect.die("not in this test"),
    remove: () => Effect.die("not in this test"),
    syncAgents: () => Effect.die("not in this test"),
    view: () => Effect.die("not in this test"),
    settled: () => Effect.die("not in this test"),
    relayTarget: (ticket) => Effect.succeed(ticket === "tk" ? { id: "s1", port: target.port } : null),
  }),
)

// The route makes its own requests with the server's fetch client, not the test's (which is bound to the test server).
const served = HttpRouter.serve(SpacesRoute.pipe(Layer.provide(Layer.mergeAll(FakeSpaces, FetchHttpClient.layer))), {
  disableListenLog: true,
  disableLogger: true,
}).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(TestPlatform()))

describe("the Space relay", () => {
  it.effect("passes a redirect back to the browser rather than following it to the host's loopback", () =>
    Effect.gen(function* () {
      const space = yield* fakeSpacePort
      target.port = space.port
      space.answers.set("/ssrf", { status: 302, headers: { location: `http://127.0.0.1:${space.port}/secret` } })
      space.answers.set("/in", { status: 307, headers: { location: "/viewer/" } })
      space.answers.set("/secret", { status: 200, body: "LOOPBACK-ONLY-SECRET" })
      const client = yield* HttpClient.HttpClient
      const get = (path: string) =>
        client.execute(HttpClientRequest.get(path)).pipe(
          Effect.flatMap((r) => Effect.map(r.text, (text) => ({ status: r.status, location: r.headers["location"], text }))),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        )

      const out = yield* get("/api/spaces/v/tk/ssrf")
      assert.strictEqual(out.status, 302)
      assert.notInclude(out.text, "LOOPBACK-ONLY-SECRET")
      assert.deepStrictEqual(space.asked, ["/ssrf"])
      // A redirect within the Space stays under the relay.
      assert.strictEqual((yield* get("/api/spaces/v/tk/in")).location, "/api/spaces/v/tk/viewer/")
      assert.strictEqual((yield* get("/api/spaces/v/nope/in")).status, 403)
    }).pipe(Effect.provide(served)),
  )

  it.effect("sandboxes a page from the Space whatever CSP it sends, and drops its cookies", () =>
    Effect.gen(function* () {
      const space = yield* fakeSpacePort
      target.port = space.port
      space.answers.set("/viewer/", {
        status: 200,
        headers: { "content-type": "text/html", "content-security-policy": "img-src *, sandbox allow-scripts allow-same-origin", "set-cookie": "a=b" },
        body: "<script>steal()</script>",
      })
      const r = yield* (yield* HttpClient.HttpClient).execute(HttpClientRequest.get("/api/spaces/v/tk/viewer/"))
      const csp = r.headers["content-security-policy"] ?? ""
      assert.notInclude(csp, "allow-same-origin")
      assert.isTrue(csp.endsWith("frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-downloads allow-pointer-lock"))
      assert.isUndefined(r.headers["set-cookie"])
    }).pipe(Effect.provide(served)),
  )
})
