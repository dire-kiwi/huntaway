import { Effect, Layer } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, type HostId, type Unavailable } from "@huntaway/contracts"
import { ClientRpcs, HostClient } from "./HostClient.ts"
import { HostSession } from "./HostSession.ts"

/**
 * How the page reaches a host: the layer of its session. `null` is the page's own server. The app uses the websocket
 * one, and the relay (relay.ts) for a linked host; tests give their own (an in-memory host) through `transportAtom`.
 */
export type Transport = (host: HostId | null) => Layer.Layer<HostClient | HostSession, Unavailable>

/**
 * A session over `socket`, with `token` on every request (none when null). The RPC client's own ping (5 s) finds a dead connection and
 * its retry schedule reconnects (opening the socket again); the session's latch follows the connection.
 */
export const socketSession = <E, R>(socket: Layer.Layer<Socket.Socket, E, R>, token: string | null): Layer.Layer<HostClient | HostSession, E, R> => {
  const session = HostSession.layer(false)
  const hooks = Layer.effect(
    RpcClient.ConnectionHooks,
    Effect.gen(function* () {
      const { connected } = yield* HostSession
      return { onConnect: Effect.asVoid(connected.open), onDisconnect: Effect.asVoid(connected.close) }
    }),
  )
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(hooks),
  )
  // No token, no header: a relayed session's requests carry nothing of the hub's (they cross to another host as they are).
  const auth = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
    next(token === null ? request : { ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  )
  return Layer.effect(HostClient, RpcClient.make(ClientRpcs, { flatten: true })).pipe(Layer.provide(protocol), Layer.provide(auth), Layer.provideMerge(session))
}

/** A session over a websocket to `url` (`ws(s)://<host>/api/rpc`), with `token` on every request. */
export const websocketTransport = (url: string, token: string | null): Layer.Layer<HostClient | HostSession> =>
  socketSession(Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)), token)
