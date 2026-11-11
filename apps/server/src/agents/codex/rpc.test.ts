import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { FAKE_CODEX } from "@huntaway/testing"
import { Effect, Predicate } from "effect"
import { tmpdir } from "node:os"
import { appServer, errorText } from "./rpc.ts"

// The app-server client against fake-codex: requests and their results, an error said as the server said it, the
// server's own messages in order, and a program that isn't there.

describe("the codex app-server client", () => {
  it.live(
    "asks, and hears what the app-server sends of its own",
    () =>
      Effect.gen(function* () {
        const server = yield* appServer({ program: FAKE_CODEX, cwd: tmpdir() })
        yield* server.initialize("0.1.0")
        const models = yield* server.request("model/list", {})
        const data = Predicate.isObject(models) ? Reflect.get(models, "data") : undefined
        assert.deepStrictEqual(
          (Array.isArray(data) ? data : []).map((m: unknown) => (Predicate.isObject(m) ? Reflect.get(m, "id") : undefined)),
          ["gpt-fake", "gpt-fake-mini"],
        )
        const failed = yield* server.request("no/such", null).pipe(Effect.match({ onFailure: errorText, onSuccess: () => "answered" }))
        assert.strictEqual(failed, "no/such: unknown method no/such")
        yield* server.request("thread/start", { cwd: tmpdir() })
        const started = yield* server.next
        assert.strictEqual(started?.["method"], "thread/started")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  )

  it.live(
    "a program that isn't there fails to start",
    () =>
      Effect.gen(function* () {
        const failed = yield* appServer({ program: "/nonexistent/codex", cwd: tmpdir(), stderr: "ignore" }).pipe(
          Effect.flatMap((server) => server.initialize("0.1.0")),
          Effect.match({ onFailure: errorText, onSuccess: () => "started" }),
        )
        assert.match(failed, /\/nonexistent\/codex/)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  )
})
