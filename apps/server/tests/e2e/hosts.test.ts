import { NodeServices, NodeWS } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, HostRpcs, HubRpcs, LinkId, LinkRpcs, PublicRpcs } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// Hosts (docs/plan/08-hosts.md), whole servers through the launcher: a hub links a host by URL and token and keeps a
// connection to it; a client of the hub reaches the host's board through the relay, with the hub's token on its
// requests and the session the hub sealed for it; forgetting the link ends it.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)
const RelayedRpcs = HostRpcs.merge(LinkRpcs)

const SERVE = ["--no-agents", "--no-discovery"]

/** A client of `port`'s own board over HTTP. */
const boardClient = (port: number, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${port}`, token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A client of `host` through `hub`'s relay, as the web app makes one: a new ticket on every connection. */
const relayedClient = (hubPort: number, token: string, ticket: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const url = Effect.map(ticket, (t) => `ws://127.0.0.1:${hubPort}/api/relay/${t}`)
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(url))),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
      ),
    )
    return yield* RpcClient.make(RelayedRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** The hub's directory once `ready` holds for it. */
const until = <E>(hosts: Stream.Stream<ReadonlyArray<Host>, E>, ready: (hosts: ReadonlyArray<Host>) => boolean) =>
  hosts.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the hub's hosts never got there") }),
  )

describe("hosts, whole servers", () => {
  it.live(
    "a hub links a host by URL and token, a client reaches the host's board through the relay, and forgetting the link ends it",
    () =>
      Effect.gen(function* () {
        const hub = yield* startServer(SERVE)
        const host = yield* startServer(SERVE)
        const board = yield* boardClient(hub.port, hub.token)
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)

        // A wrong token is refused before anything is stored.
        const wrong = yield* Effect.exit(board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: "nope" }))
        assert.isTrue(Exit.isFailure(wrong))
        assert.strictEqual((yield* board("hub.hosts.list", undefined)).length, 1)

        const added = yield* board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}/`, token: host.token })
        assert.strictEqual(added.id, hostInfo.host_id)
        assert.strictEqual(added.url, `http://127.0.0.1:${host.port}`)
        const linked = yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))
        const entry = linked.find((h) => h.id === hostInfo.host_id)
        assert.strictEqual(entry?.mode, "outbound")
        assert.strictEqual(entry?.status, "connected")
        assert.strictEqual(entry?.version, hostInfo.version)
        assert.isTrue(linked[0]?.local)

        // Through the relay: the host's own board, with the hub's token on each request.
        const ticket = Effect.map(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }), (r) => r.ticket).pipe(Effect.orDie)
        const relayed = yield* relayedClient(hub.port, hub.token, ticket)
        assert.strictEqual((yield* relayed("host.info", undefined)).host_id, hostInfo.host_id)
        const profiles = yield* relayed("profiles.list", undefined)
        assert.isArray(profiles)
        // The relayed session never has `link`.
        const asLink = yield* Effect.exit(
          relayed("link.hello", {
            host_id: hostInfo.host_id,
            name: "x",
            protocol: 1,
            version: "x",
            capabilities: [],
            commit: null,
            agents: false,
            updates_from: null,
          }),
        )
        assert.isTrue(Exit.isFailure(asLink))

        // A ticket is used once.
        const once = yield* board("hub.hosts.openRelay", { host_id: hostInfo.host_id })
        const first = yield* relayedClient(hub.port, hub.token, Effect.succeed(once.ticket))
        assert.strictEqual((yield* first("host.info", undefined)).host_id, hostInfo.host_id)

        yield* board("hub.hosts.update", { id: LinkId.make(added.id), name: "renamed", uplink: true })
        const renamed = (yield* board("hub.hosts.list", undefined)).find((h) => h.id === hostInfo.host_id)
        assert.strictEqual(renamed?.name, "renamed")
        assert.isTrue(renamed?.uplink)

        yield* board("hub.hosts.remove", { id: LinkId.make(added.id) })
        assert.strictEqual((yield* board("hub.hosts.list", undefined)).length, 1)
        const gone = yield* Effect.exit(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }))
        assert.isTrue(Exit.isFailure(gone))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})
