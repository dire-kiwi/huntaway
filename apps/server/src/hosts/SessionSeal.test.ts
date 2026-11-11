import { NodeHttpServer, NodeWS } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { Headers, HttpRouter, HttpServer } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, LINK_HEADER, RequiredScope, Session, SESSION_HEADER } from "@huntaway/contracts"
import type { AssertedSession } from "@huntaway/contracts"
import { TestPlatform } from "@huntaway/testing"
import { Identity } from "../platform/Identity.ts"
import { AuthLive } from "../rpc/AuthLive.ts"
import { SessionSeal } from "./SessionSeal.ts"

// 7.0, the first check (docs/plan/08-hosts.md, To check early): the headers of a websocket's upgrade request reach the
// RPC middleware with every request on that socket, and the session a hub seals into them cannot be forged by the
// client whose frames pass through: not by a header of the same name in its own requests (the RPC server joins the two,
// `a, b`, and the seal fails), not by a seal under another key, and not by asking for more than a board user's scopes.
// On a real HTTP server, over a real websocket, with the server's own `Auth`.

const WhoAmI = Schema.Struct({ kind: Schema.String, scopes: Schema.Array(Schema.String), via_link: Schema.NullOr(Schema.String) })

const whoAmI = Effect.gen(function* () {
  const s = yield* Session
  return { kind: s.kind, scopes: [...s.scopes].toSorted(), via_link: s.via_link }
})

class Checks extends RpcGroup.make(
  Rpc.make("check.read", { success: WhoAmI }).annotate(RequiredScope, "read"),
  Rpc.make("check.admin", { success: WhoAmI }).annotate(RequiredScope, "admin"),
  Rpc.make("check.link", { success: WhoAmI }).annotate(RequiredScope, "link"),
).middleware(Auth) {}

const handlers = Checks.toLayer({ "check.read": () => whoAmI, "check.admin": () => whoAmI, "check.link": () => whoAmI })

/** The checks on a real server on a free port, with the server's `Auth` over a test identity. */
const server = HttpRouter.serve(
  RpcServer.layerHttp({ group: Checks, path: "/api/rpc", protocol: "websocket" }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(AuthLive),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(SessionSeal.layer), Layer.provideMerge(TestPlatform()))

/**
 * A client over one websocket whose upgrade request carries `upgrade` headers; each request carries `request` headers
 * (its own `Auth` puts them on, as a relayed browser's puts its hub token).
 */
const connect = (upgrade: Record<string, string>, request: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address
    const url = `ws://127.0.0.1:${address._tag === "UnixPathAddress" ? 0 : address.port}/api/rpc`
    // Built into the test's scope, so the socket lives as long as the client.
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(url, { headers: upgrade })),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request: r }) => next({ ...r, headers: Headers.setAll(r.headers, request) })),
      ),
    )
    return yield* RpcClient.make(Checks).pipe(Effect.provideContext(context))
  })

const HUB = "a".repeat(64)
const asserted = (overrides: Partial<AssertedSession> = {}) =>
  Effect.map(Clock.currentTimeMillis, (now): AssertedSession => ({
    kind: "board",
    scopes: ["read", "operate"],
    device_id: null,
    exp: now + 60_000,
    ...overrides,
  }))

/** The upgrade headers a hub sends: its id and `session` sealed under `key` (the host's board token by default). */
const sealed = (session: AssertedSession, key?: Redacted.Redacted) =>
  Effect.gen(function* () {
    const token = key ?? (yield* Identity).token
    return { [LINK_HEADER]: HUB, [SESSION_HEADER]: yield* (yield* SessionSeal).seal(token, session) }
  })

const failure = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit) ? Exit.findErrorOption(exit).pipe((e) => (e._tag === "Some" ? e.value._tag : "defect")) : "ok",
  )

/** What a `check.read` on a socket with `upgrade` headers fails with. */
const refused = (upgrade: Record<string, string>) => Effect.flatMap(connect(upgrade), (client) => failure(client["check.read"]()))

describe("a relayed socket's session (7.0)", () => {
  it.live("the upgrade's headers reach Auth on every request of the socket, and the hub token on each is ignored", () =>
    Effect.gen(function* () {
      const client = yield* connect(yield* sealed(yield* asserted()), { authorization: "Bearer the-hub-token" })
      for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(yield* client["check.read"](), { kind: "board", scopes: ["operate", "read"], via_link: HUB })
      }
      assert.strictEqual(yield* failure(client["check.admin"]()), "Forbidden")
      assert.deepStrictEqual(yield* client["check.read"](), { kind: "board", scopes: ["operate", "read"], via_link: HUB })
    }).pipe(Effect.scoped, Effect.provide(server)),
  )

  it.live("a header of the same name in a request spoils the seal instead of replacing it", () =>
    Effect.gen(function* () {
      const forged = yield* sealed(yield* asserted({ scopes: ["read", "operate", "admin", "link"], kind: "link" }), Redacted.make("not the key"))
      const honest = yield* sealed(yield* asserted())
      // A relayed client adds its own claim to each request: every request is refused, none gets more.
      const client = yield* connect(honest, forged)
      assert.strictEqual(yield* failure(client["check.read"]()), "Unauthorized")
      assert.strictEqual(yield* failure(client["check.admin"]()), "Unauthorized")
      // Even the hub's own value, repeated, spoils it.
      const echo = yield* connect(honest, honest)
      assert.strictEqual(yield* failure(echo["check.read"]()), "Unauthorized")
    }).pipe(Effect.scoped, Effect.provide(server)),
  )

  it.live("a socket the board's own client opened takes no seal from its requests", () =>
    Effect.gen(function* () {
      // A sealed session needs this host's token; a client that has it needs no seal. Without it, nothing passes.
      const forged = yield* sealed(yield* asserted({ scopes: ["read", "admin"] }), Redacted.make("not the key"))
      const client = yield* connect({}, forged)
      assert.strictEqual(yield* failure(client["check.read"]()), "Unauthorized")
      const token = Redacted.value((yield* Identity).token)
      const withToken = yield* connect({}, { ...forged, authorization: `Bearer ${token}` })
      assert.strictEqual(yield* failure(withToken["check.read"]()), "Unauthorized", "a seal in a request is never ignored for the token beside it")
    }).pipe(Effect.scoped, Effect.provide(server)),
  )

  it.live("a seal under another key, an expired one, a bad link id or a broken value is refused", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* refused(yield* sealed(yield* asserted(), Redacted.make("the hub token"))), "Unauthorized")
      assert.strictEqual(yield* refused(yield* sealed(yield* asserted({ exp: (yield* Clock.currentTimeMillis) - 1 }))), "Unauthorized")
      const good = yield* sealed(yield* asserted())
      assert.strictEqual(yield* refused({ ...good, [LINK_HEADER]: "x y" }), "Unauthorized")
      assert.strictEqual(yield* refused({ [SESSION_HEADER]: good[SESSION_HEADER] ?? "" }), "Unauthorized")
      assert.strictEqual(yield* refused({ [LINK_HEADER]: HUB }), "Unauthorized")
      const value = good[SESSION_HEADER] ?? ""
      const [payload = "", tag = ""] = value.split(".")
      assert.strictEqual(yield* refused({ ...good, [SESSION_HEADER]: `${payload}x.${tag}` }), "Unauthorized")
      assert.strictEqual(yield* refused({ ...good, [SESSION_HEADER]: `${payload}.${tag.slice(1)}A` }), "Unauthorized")
    }).pipe(Effect.scoped, Effect.provide(server)),
  )

  it.live("a session never gets more than its kind may have: link only for a hub's own connection", () =>
    Effect.gen(function* () {
      const board = yield* connect(yield* sealed(yield* asserted({ scopes: ["read", "admin", "link"] })))
      assert.deepStrictEqual((yield* board["check.admin"]()).scopes, ["admin", "read"])
      assert.strictEqual(yield* failure(board["check.link"]()), "Forbidden")
      const device = yield* connect(yield* sealed(yield* asserted({ kind: "device", scopes: ["read", "operate", "admin"] })))
      assert.strictEqual(yield* failure(device["check.admin"]()), "Forbidden")
      const link = yield* connect(yield* sealed(yield* asserted({ kind: "link", scopes: ["link", "read"] })))
      assert.deepStrictEqual(yield* link["check.link"](), { kind: "link", scopes: ["link", "read"], via_link: HUB })
    }).pipe(Effect.scoped, Effect.provide(server)),
  )
})
