import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeWS from "@effect/platform-node/NodeWS"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, Capability, HostRpcs, HubRpcs, PublicRpcs } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// Paired devices (HE-91), whole servers: a phone pairs with the hub by the PIN its board shows, and its token is a
// device's session there and, through the relay, on the host the hub links: `read` and `operate`, no more. Unpairing it
// refuses the token and ends the sockets the hub relays for it.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)

const SERVE = ["--no-agents", "--no-discovery"]

const boardClient = (port: number, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${port}`, token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A client of a host through `hubPort`'s relay over one ticket's socket, with `token` on its requests. */
const relayedClient = (hubPort: number, token: string, ticket: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
          Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(`ws://127.0.0.1:${hubPort}/api/relay/${ticket}`))),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
      ),
    )
    return yield* RpcClient.make(HostRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

const failedWith = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit) ? "ok" : Exit.findErrorOption(exit).pipe((e) => (e._tag === "Some" ? e.value._tag : "defect")),
  )

const until = <E>(hosts: Stream.Stream<ReadonlyArray<Host>, E>, ready: (hosts: ReadonlyArray<Host>) => boolean) =>
  hosts.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the hub's hosts never got there") }),
  )

describe("paired devices, whole servers (HE-91)", () => {
  it.live(
    "a phone pairs by PIN, reaches the hub and its linked host as a device, and unpairing it cuts it off",
    () =>
      Effect.gen(function* () {
        const hub = yield* startServer(SERVE)
        const host = yield* startServer(SERVE)
        const board = yield* boardClient(hub.port, hub.token)
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)
        yield* board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: host.token })
        yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))

        // The phone, with no token yet: it learns the board pairs, and pairing is off until the board turns it on.
        const stranger = yield* boardClient(hub.port, "")
        const health = yield* stranger("public.health", undefined)
        assert.include(health.capabilities, Capability.devicePairing)
        assert.isString(health.name)
        assert.strictEqual(yield* failedWith(stranger("public.pair", { pin: "000000", name: "Phone" })), "Unavailable")

        const { pin } = yield* board("hub.devices.startPairing", undefined)
        const paired = yield* stranger("public.pair", { pin, name: "Pixel 8" })
        assert.strictEqual(paired.host_id, (yield* board("host.info", undefined)).host_id)
        const listed = yield* board("hub.devices.list", undefined)
        assert.deepStrictEqual(
          listed.devices.map((d) => d.name),
          ["Pixel 8"],
        )
        assert.isNull(listed.pairing)

        // On the hub: reads and operating, but not settings or admin.
        const phone = yield* boardClient(hub.port, paired.token)
        assert.isArray(yield* phone("hub.hosts.list", undefined))
        assert.isArray(yield* phone("profiles.list", undefined))
        assert.strictEqual(yield* failedWith(phone("hub.devices.list", undefined)), "Forbidden")
        assert.strictEqual(yield* failedWith(phone("profiles.create", { profile: { name: "Nope" } })), "Forbidden")
        assert.strictEqual(yield* failedWith(phone("hub.devices.startPairing", undefined)), "Forbidden")

        // On the linked host, through the relay: a device's session there too.
        const { ticket } = yield* phone("hub.hosts.openRelay", { host_id: hostInfo.host_id })
        const relayed = yield* relayedClient(hub.port, paired.token, ticket)
        assert.strictEqual((yield* relayed("host.info", undefined)).host_id, hostInfo.host_id)
        assert.strictEqual(yield* failedWith(relayed("profiles.create", { profile: { name: "Nope" } })), "Forbidden")

        // Unpaired: the token is refused, and the relayed socket ends.
        yield* board("hub.devices.revoke", { id: paired.device.id })
        assert.strictEqual(yield* failedWith(phone("hub.hosts.list", undefined)), "Unauthorized")
        const after = yield* failedWith(relayed("host.info", undefined).pipe(Effect.timeout("10 seconds")))
        assert.notStrictEqual(after, "ok")

        // A device unpairs itself; a board session can't "unpair itself".
        const second = yield* stranger("public.pair", { pin: (yield* board("hub.devices.startPairing", undefined)).pin, name: "Tablet" })
        const tablet = yield* boardClient(hub.port, second.token)
        yield* tablet("hub.devices.unpair", undefined)
        assert.strictEqual(yield* failedWith(tablet("hub.hosts.list", undefined)), "Unauthorized")
        assert.strictEqual(yield* failedWith(board("hub.devices.unpair", undefined)), "Invalid")
        assert.deepStrictEqual((yield* board("hub.devices.list", undefined)).devices, [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})
