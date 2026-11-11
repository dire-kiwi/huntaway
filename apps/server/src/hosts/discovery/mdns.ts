import { Duration, Effect, Exit, Fiber, Scope, Stream, SubscriptionRef } from "effect"
import { HostId } from "@huntaway/contracts"
import { asksForUs, hostsHeard, isPrivate, isTailscale, lanAddresses, MDNS_GROUP, MDNS_PORT, parse, query, response } from "./dns.ts"
import type { Ad, Found, Peer } from "./dns.ts"
import { Udp } from "./Udp.ts"
import type { UdpMessage, UdpSocket } from "./Udp.ts"

// The responder and the browser of mDNS discovery (the old `respond` and `discover`), over `Udp`.

/** How often the responder's socket is renewed. */
export const RENEW = Duration.seconds(30)
/** How long a browse waits for answers. */
export const WAIT = Duration.millis(1500)

/** A responder: the port it answers on, and how many times its socket was renewed. Closed with its scope. */
export interface Responder {
  readonly port: number
  readonly renewed: SubscriptionRef.SubscriptionRef<number>
}

export interface RespondOptions {
  /** Tests answer direct queries on loopback only: a port of their own (0) and `127.0.0.1`. */
  readonly port?: number
  readonly address?: string
  readonly renew?: Duration.Input
}

/** A socket on `port` that answers queries for `ad`, joined on the networks there are now, in the current scope. */
const answerOn = (ad: Effect.Effect<Ad>, port: number, address: string | undefined) =>
  Effect.gen(function* () {
    const udp = yield* Udp
    const sock = yield* udp.bind(port, address)
    const lan = Effect.map(udp.interfaces, lanAddresses)
    if (address === undefined) {
      yield* sock.setMulticastTtl(255)
      for (const ip of yield* lan) yield* sock.join(MDNS_GROUP, ip)
    }
    // One query at a time: the answers to two that come together mustn't interleave their interfaces.
    const answer = (m: UdpMessage) =>
      Effect.gen(function* () {
        const p = parse(m.data)
        if (p === null || !asksForUs(p)) return
        const ips = yield* lan
        if (m.port !== MDNS_PORT) {
          // A "legacy unicast" query (RFC 6762 §6.7): answered to its sender, with its id, if that is on a private network.
          if (isPrivate(m.address)) yield* sock.send(response(yield* ad, ips, p.id), m.port, m.address)
          return
        }
        // On the group, out of each network we're on now, for the hubs listening there.
        yield* sendOut(sock, response(yield* ad, ips), ips)
      })
    yield* sock.messages.pipe(Stream.runForEach(answer), Effect.forkScoped)
    return sock
  })

/** Sends `msg` to the group out of each of `ips` in turn (each once the last has gone). */
export const sendOut = (sock: UdpSocket, msg: Uint8Array, ips: ReadonlyArray<string>, port = MDNS_PORT, group = MDNS_GROUP) =>
  Effect.forEach(ips, (ip) => sock.sendVia(msg, port, group, ip), { concurrency: 1, discard: true })

/**
 * Advertises `ad` on mDNS for as long as the scope lasts: answers queries for the service on the group, and direct ones
 * (from another port than 5353, such as a hub asking a Tailscale peer) to whoever asked, if that is on a private network.
 * Null if the port can't be had.
 *
 * Every `renew` the socket is swapped for a new one, joined on the networks there are then. Linux keeps a socket's
 * membership per interface, and keeps it for an interface that has gone until the socket closes, up to 20 a socket
 * (net.ipv4.igmp_max_memberships): a VPN's `tun0` that reconnects, or a dock's Ethernet plugged in again, is a new
 * interface each time, even with the same address, so one socket would soon be unable to join any. (Renewed whether or
 * not the addresses changed: an interface that came back with the same address looks the same.) The new socket is bound
 * before the old one closes, so no query falls between them.
 */
export const respond = (ad: Effect.Effect<Ad>, options: RespondOptions = {}) =>
  Effect.gen(function* () {
    const outer = yield* Effect.scope
    /** A socket on `port` in a scope of its own, which closes it. */
    const openOn = (port: number) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(outer)
        const sock = yield* answerOn(ad, port, options.address).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        return { sock, scope }
      })
    const first = yield* Effect.option(openOn(options.port ?? MDNS_PORT))
    if (first._tag === "None") return null
    const port = first.value.sock.port
    let current = first.value.scope
    const renewed = yield* SubscriptionRef.make(0)
    const renew = Effect.gen(function* () {
      // The port couldn't be had again: the old socket goes on.
      const next = yield* Effect.option(openOn(port))
      if (next._tag === "None") return
      yield* Scope.close(current, Exit.void)
      current = next.value.scope
      yield* SubscriptionRef.update(renewed, (n) => n + 1)
    })
    yield* renew.pipe(Effect.delay(options.renew ?? RENEW), Effect.forever, Effect.forkScoped)
    return { port, renewed } satisfies Responder
  })

export interface BrowseOptions {
  /** Where peers' mDNS answers. */
  readonly port?: number
  /** The HTTP port Tailscale peers are tried on. */
  readonly httpPort: number
  readonly wait?: Duration.Input
  /** Tests: ask these addresses directly instead of the group (from a port of our own, so the answers come to it). */
  readonly targets?: ReadonlyArray<string>
  /** The online Tailscale peers, or null without Tailscale. */
  readonly peers: ReadonlyArray<Peer> | null
  /** What a URL says on `/api/health`, if it answers as a host does. */
  readonly probe: (url: string, timeout: Duration.Input) => Effect.Effect<Probed | null>
}

/** What a host says of itself on `/api/health`. */
export interface Probed {
  readonly host_id: string | null
  readonly version: string | null
  readonly protocol: number | null
  readonly capabilities: ReadonlyArray<string>
}

/** Asks for hosts on the LAN and Tailscale, and gathers the answers for `wait`. `tailscale` is whether it's up. */
export const browse = (o: BrowseOptions) =>
  Effect.gen(function* () {
    const udp = yield* Udp
    const port = o.port ?? MDNS_PORT
    const wait = o.wait ?? WAIT
    const peerIps = new Set((o.peers ?? []).map((p) => p.ip))
    const found = new Map<string, Found>()
    const answered = new Set<string>()

    const heard = (m: UdpMessage) =>
      Effect.sync(() => {
        for (const { ip, host: h } of hostsHeard(m.data, m.address)) {
          answered.add(m.address)
          const via = peerIps.has(ip) || isTailscale(ip) ? "tailscale" : "lan"
          // Once on each: a host on several networks answers on each of them.
          const key = `${h.host_id} ${via}`
          if (!found.has(key)) found.set(key, { ...h, via })
        }
      })
    const listen = (sock: UdpSocket) => sock.messages.pipe(Stream.runForEach(heard), Effect.forkScoped)

    // Tailscale peers on their HTTP port too, meanwhile: one whose firewall drops the unicast query is found that way.
    const probing = yield* Effect.forEach(o.peers ?? [], (p) => Effect.map(o.probe(`http://${p.ip}:${o.httpPort}`, wait), (h) => [p, h] as const), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild)
    yield* Effect.scoped(
      Effect.gen(function* () {
        // On the group, answers go to port 5353, so we listen there too (beside this host's own responder), on each network.
        if (o.targets === undefined) {
          const group = yield* Effect.option(udp.bind(MDNS_PORT))
          if (group._tag === "Some") {
            const ips = lanAddresses(yield* udp.interfaces)
            yield* listen(group.value)
            for (const ip of ips) yield* group.value.join(MDNS_GROUP, ip)
            yield* group.value.setMulticastTtl(255)
            yield* sendOut(group.value, query(), ips)
          }
        }
        // Direct queries go from a port of our own, not 5353, so they're answered to it (RFC 6762 §6.7's legacy unicast).
        const direct = yield* Effect.option(udp.bind(0))
        if (direct._tag === "Some") {
          yield* listen(direct.value)
          for (const t of [...(o.targets ?? []), ...peerIps]) yield* direct.value.send(query(1), port, t)
        }
        yield* Effect.sleep(wait)
      }),
    ).pipe(Effect.ignore)
    for (const [p, h] of yield* Fiber.join(probing)) {
      if (h === null || answered.has(p.ip)) continue
      const url = `http://${p.ip}:${o.httpPort}`
      found.set(url, {
        host_id: h.host_id === null ? null : HostId.make(h.host_id),
        name: p.name,
        url,
        via: "tailscale",
        version: h.version,
        protocol: h.protocol,
        capabilities: h.capabilities,
      })
    }
    return { hosts: [...found.values()], tailscale: o.peers !== null }
  })
