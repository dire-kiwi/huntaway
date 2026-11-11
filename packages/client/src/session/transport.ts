import { Effect, Layer } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, type HostId, Unavailable } from "@huntaway/contracts"
import { ClientRpcs, HostClient } from "./HostClient.ts"
import { HostSession } from "./HostSession.ts"

/**
 * How the page reaches a host: the layer of its session. `null` is the page's own server. The app uses the websocket
 * one; tests give their own (an in-memory host) through `transportAtom`.
 */
export type Transport = (host: HostId | null) => Layer.Layer<HostClient | HostSession, Unavailable>

/**
 * A session over a websocket to `url` (`ws(s)://<host>/api/rpc`), with `token` on every request. The RPC client's own
 * ping (5 s) finds a dead connection and its retry schedule reconnects; the session's latch follows the connection.
 */
export const websocketTransport = (url: string, token: string | null): Layer.Layer<HostClient | HostSession> => {
  const session = HostSession.layer(false)
  const hooks = Layer.effect(
    RpcClient.ConnectionHooks,
    Effect.gen(function* () {
      const { connected } = yield* HostSession
      return { onConnect: Effect.asVoid(connected.open), onDisconnect: Effect.asVoid(connected.close) }
    }),
  )
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(hooks),
  )
  const auth = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token ?? ""}`) }),
  )
  return Layer.effect(HostClient, RpcClient.make(ClientRpcs, { flatten: true })).pipe(Layer.provide(protocol), Layer.provide(auth), Layer.provideMerge(session))
}

/** A linked host's session, through the hub's relay: M7. Until then there is none. */
export const relayTransport = (host: HostId): Layer.Layer<HostClient | HostSession, Unavailable> =>
  Layer.effect(HostClient, Effect.fail(new Unavailable({ what: `host ${host}`, reason: "linked hosts are reached through the hub, which comes later" }))).pipe(
    Layer.provideMerge(HostSession.layer(false)),
  )
