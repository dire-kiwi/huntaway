import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import type { Interfaces } from "./dns.ts"

// UDP sockets and the machine's network interfaces, for mDNS (`hosts/Discovery`). Node's `dgram` behind a small
// service rather than Effect's `DatagramSocket`: that one joins a multicast group, but sets the interface multicast goes
// out of once, when the socket opens, and the responder sends each answer out of every LAN interface in turn from the
// one socket on port 5353 (the old `send_out`). Nor has Effect a service for the interfaces. Node's two functions are
// handed in by the composition root, as Node's HTTP server is (`Udp.layerNode`), so nothing here imports Node; tests
// give real sockets on 127.0.0.1 or fakes.

/** A datagram that arrived, and who sent it. */
export interface UdpMessage {
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
}

/** A bound UDP socket, closed with its scope. */
export interface UdpSocket {
  /** The port it is bound to. */
  readonly port: number
  /** What arrives on it, in order, for as long as it is open. */
  readonly messages: Stream.Stream<UdpMessage>
  /** Sends `data` to `address:port`, once it has gone (a failure is logged, not raised). */
  readonly send: (data: Uint8Array, port: number, address: string) => Effect.Effect<void>
  /** Sends `data` to the multicast `group:port` out of the interface with address `via`, once it has gone. */
  readonly sendVia: (data: Uint8Array, port: number, group: string, via: string) => Effect.Effect<void>
  /** Joins multicast `group` on the interface with address `via` (one joined already is no failure). */
  readonly join: (group: string, via: string) => Effect.Effect<void>
  readonly setMulticastTtl: (ttl: number) => Effect.Effect<void>
}

/** A UDP port that could not be had. */
export class UdpBindFailed extends Schema.TaggedError<UdpBindFailed, { readonly brand: unique symbol }>()("UdpBindFailed", {
  port: Schema.Int,
  reason: Schema.String,
}) {}

export interface UdpShape {
  /** A UDP socket on `port` (0: a free one), on `address` or every address, shared with other sockets on that port. */
  readonly bind: (port: number, address?: string) => Effect.Effect<UdpSocket, UdpBindFailed, Scope.Scope>
  /** This machine's network interfaces now. */
  readonly interfaces: Effect.Effect<Interfaces>
}

/** What `Udp.layerNode` needs of a Node `dgram.Socket`. */
export interface DgramSocket {
  bind(port: number, address: string | undefined, callback: () => void): unknown
  on(event: "message", listener: (msg: Uint8Array, from: { readonly address: string; readonly port: number }) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  off(event: "error", listener: (error: Error) => void): unknown
  send(msg: Uint8Array, port: number, address: string, callback: (error: Error | null) => void): void
  addMembership(group: string, via: string): void
  setMulticastInterface(via: string): void
  setMulticastTTL(ttl: number): unknown
  address(): { readonly port: number }
  close(): unknown
}

/** Node's `dgram.createSocket` and `os.networkInterfaces`. */
export interface NodeUdp {
  readonly createSocket: (options: { readonly type: "udp4"; readonly reuseAddr: boolean }) => DgramSocket
  readonly networkInterfaces: () => Interfaces
}

/** Runs `go` with a callback for when a datagram has gone: a failure is logged, as the old server did. */
const sent = (go: (done: (error: Error | null) => void) => void, what: string) =>
  Effect.callback<void>((resume) => {
    try {
      go((error) => resume(error === null ? Effect.void : Effect.logDebug(`discovery: sending ${what}: ${error.message}`)))
    } catch (error) {
      resume(Effect.logDebug(`discovery: sending ${what}`, error))
    }
  })

/** How many datagrams wait unread before the oldest are dropped. */
const BACKLOG = 1024

export class Udp extends Context.Service<Udp, UdpShape>()("huntaway-server/hosts/discovery/Udp") {
  /** Over Node's `dgram` and `os`, given by the composition root. */
  static readonly layerNode = (node: NodeUdp) =>
    Layer.succeed(
      Udp,
      Udp.of({
        interfaces: Effect.sync(node.networkInterfaces),
        bind: (port, address) =>
          Effect.gen(function* () {
            const socket = yield* Effect.acquireRelease(
              Effect.callback<DgramSocket, UdpBindFailed>((resume) => {
                const sock = node.createSocket({ type: "udp4", reuseAddr: true })
                const fail = (error: Error) => {
                  sock.close()
                  resume(Effect.fail(new UdpBindFailed({ port, reason: error.message })))
                }
                sock.once("error", fail)
                sock.bind(port, address, () => {
                  sock.off("error", fail)
                  resume(Effect.succeed(sock))
                })
              }),
              (sock) => Effect.sync(() => sock.close()),
            )
            const queue = yield* Queue.sliding<UdpMessage>(BACKLOG)
            socket.on("message", (data, from) => Queue.offerUnsafe(queue, { data, address: from.address, port: from.port }))
            socket.on("error", () => undefined)
            return {
              port: socket.address().port,
              messages: Stream.fromQueue(queue),
              send: (data, to, at) => sent((done) => socket.send(data, to, at, done), `to ${at}`),
              // Set and sent together: `send` reads the interface when the datagram goes, so the next one is set only
              // after this one has gone.
              sendVia: (data, to, group, via) =>
                sent((done) => {
                  socket.setMulticastInterface(via)
                  socket.send(data, to, group, done)
                }, `out of ${via}`),
              join: (group, via) =>
                Effect.suspend(() => {
                  try {
                    socket.addMembership(group, via)
                    return Effect.void
                  } catch (error) {
                    // A socket's memberships are capped (net.ipv4.igmp_max_memberships, 20 by default); one joined
                    // already (two addresses on one interface) fails too.
                    return Effect.logDebug(`discovery: joining mDNS on ${via}`, error)
                  }
                }),
              setMulticastTtl: (ttl) => Effect.sync(() => socket.setMulticastTTL(ttl)).pipe(Effect.asVoid),
            } satisfies UdpSocket
          }),
      }),
    )
}
