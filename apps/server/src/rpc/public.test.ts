import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { PublicRpcs } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { PublicHandlers } from "./public.ts"

// `public.openToken` (huntaway's serve.ts `open_token` and `loopback_host`, serve.test.ts): the board token for any
// browser that asks, only with `--open-token`, and on a loopback-only server only for a loopback `Host` header, so a page
// on another site that rebinds its name to 127.0.0.1 can't read it.

/** What `public.openToken` answers a request with `Host: host` (none for undefined) on a server started with `config`. */
const ask = (config: Partial<ServerConfigShape>, host: string | undefined) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(PublicRpcs)
    return yield* client["public.openToken"](undefined, { headers: host === undefined ? {} : { host } }).pipe(
      Effect.map((r) => r.token),
      Effect.catchTag("NotFound", () => Effect.succeed(null)),
    )
  }).pipe(Effect.scoped, Effect.provide(PublicHandlers.pipe(Layer.provideMerge(TestBoard(config)))))

describe("public.openToken", () => {
  it.effect("is not there without --open-token", () =>
    Effect.gen(function* () {
      assert.isNull(yield* ask({ openToken: false, host: "0.0.0.0" }, "example.com"))
      assert.isNull(yield* ask({ openToken: false }, "127.0.0.1:7879"))
    }),
  )

  it.effect("gives the token to any Host on a server that listens beyond this machine", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* ask({ openToken: true, host: "0.0.0.0" }, "preview.example.com"), "test-token")
      assert.strictEqual(yield* ask({ openToken: true, host: "0.0.0.0" }, undefined), "test-token")
    }),
  )

  it.effect("on a loopback-only server, gives it only for a loopback Host header", () =>
    Effect.gen(function* () {
      for (const bind of ["127.0.0.1", "localhost", "::1", "127.0.0.2"]) {
        for (const host of ["127.0.0.1:7878", "localhost:80", "LOCALHOST", "[::1]:9", "127.0.0.1"]) {
          assert.strictEqual(yield* ask({ openToken: true, host: bind }, host), "test-token", `${bind} ${host}`)
        }
        for (const host of ["attacker.example:7878", "127.0.0.1.evil.test", "localhost.evil.test:1", "", undefined]) {
          assert.isNull(yield* ask({ openToken: true, host: bind }, host), `${bind} ${host}`)
        }
      }
    }),
  )
})
