import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"
import type { HostClient } from "./HostClient.ts"
import type { HostSession } from "./HostSession.ts"
import { socketSession } from "./transport.ts"

// A linked host's session (docs/plan/08-hosts.md, Relay): the client asks its hub for a ticket (`hub.hosts.openRelay`)
// and opens `ws(s)://<hub>/api/relay/<ticket>`, which the hub pipes to that host's `/api/rpc`. A ticket is single-use,
// so every connection, the RPC client's reconnects included, asks for a new one. Its requests carry no token: the hub
// pipes their frames to the host as they are, so the hub's own token would reach that host (which takes the session the
// hub sealed for the socket, and nothing from the requests).

/** The relay's websocket URL on the page's own server, whose RPC is at `serverUrl` (`ws(s)://<hub>/api/rpc`). */
export const relayUrl = (serverUrl: string, ticket: string): string => `${serverUrl.replace(/\/api\/rpc\/?$/, "")}/api/relay/${encodeURIComponent(ticket)}`

const openError = (cause: unknown) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })

/**
 * A socket to a linked host through the hub at `serverUrl`: each time it is opened, `ticket` is asked for a new ticket
 * first. A ticket that cannot be had is an open error, which the RPC client retries as it does a host that is down. The
 * wait for a ticket can be interrupted (the session closing while the host is away).
 */
export const relaySocket = <E, R>(
  serverUrl: string,
  ticket: Effect.Effect<string, E, R>,
): Effect.Effect<Socket.Socket, never, Socket.WebSocketConstructor | R> =>
  Effect.gen(function* () {
    const makeWs = yield* Socket.WebSocketConstructor
    return yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.interruptible(ticket).pipe(
          Effect.mapError(openError),
          Effect.flatMap((t) => Effect.try({ try: () => makeWs(relayUrl(serverUrl, t)), catch: openError })),
        ),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
    )
  })

/** A linked host's session through the hub's relay at `serverUrl`. No token goes on its requests (see above). */
export const relayTransport = <E, R>(serverUrl: string, ticket: Effect.Effect<string, E, R>): Layer.Layer<HostClient | HostSession, never, R> =>
  socketSession(Layer.effect(Socket.Socket, relaySocket(serverUrl, ticket)).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)), null)
