import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { createSocket } from "node:dgram"
import { HostId } from "@huntaway/contracts"
import { MDNS_PORT, parse, query, response } from "./dns.ts"
import type { Ad, Interfaces } from "./dns.ts"
import { browse, respond, sendOut, WAIT } from "./mdns.ts"
import type { Probed } from "./mdns.ts"
import { Udp } from "./Udp.ts"
import type { UdpMessage, UdpSocket } from "./Udp.ts"

// The responder and the browser (the old discovery.test.ts). Never on the real mDNS port or group: real sockets bind
// 127.0.0.1 on ports of their own, through a `Udp` that dies on 5353, on a multicast send or join, and on any address
// but loopback, and sees no network interfaces (so nothing is joined or sent out of one); the multicast cases use a fake.

const ad = (hostId: string, port: number): Ad => ({ host_id: hostId, host_name: `name-${hostId}`, port, version: "1.2.3", protocol: 1 })
const LOOPBACK = "127.0.0.1"

const refuse = (what: string) => Effect.die(`a test tried ${what}`)

/** Real sockets on loopback only, and every datagram that arrives, with the port it arrived on. */
const loopbackUdp = Effect.gen(function* () {
  const arrived = yield* Queue.unbounded<UdpMessage & { readonly to: number }>()
  const node = yield* Udp.pipe(Effect.provide(Udp.layerNode({ createSocket, networkInterfaces: (): Interfaces => ({}) })))
  const guarded = (sock: UdpSocket): UdpSocket => ({
    port: sock.port,
    messages: sock.messages.pipe(Stream.tap((m) => Queue.offer(arrived, { ...m, to: sock.port }))),
    send: (data, port, address) => (port === MDNS_PORT || address !== LOOPBACK ? refuse(`to send to ${address}:${port}`) : sock.send(data, port, address)),
    sendVia: () => refuse("a multicast send"),
    join: () => refuse("to join a multicast group"),
    setMulticastTtl: () => refuse("to set a multicast TTL"),
  })
  const udp = Udp.of({
    interfaces: Effect.succeed({}),
    // A port of its own (0) on any address, or loopback; never 5353.
    bind: (port, address) =>
      port === MDNS_PORT || (port !== 0 && address !== LOOPBACK)
        ? refuse(`to bind ${address ?? "every address"}:${port}`)
        : Effect.map(node.bind(port, address), guarded),
  })
  return { layer: Layer.succeed(Udp, udp), arrived }
})

/** Waits for `n` datagrams that arrived anywhere but on `not`. */
const arrivals = (arrived: Queue.Queue<UdpMessage & { readonly to: number }>, n: number, not: number) =>
  Stream.fromQueue(arrived).pipe(
    Stream.filter((m) => m.to !== not),
    Stream.take(n),
    Stream.runCollect,
  )

const noProbe = () => Effect.succeed(null)

describe("the mDNS responder and browser, on loopback", () => {
  it.effect("a query on localhost finds the host answering there, once however often it answers", () =>
    Effect.gen(function* () {
      const { layer, arrived } = yield* loopbackUdp
      const r = Option.getOrThrow(Option.fromNullOr(yield* respond(Effect.succeed(ad("h1", 7999)), { port: 0, address: LOOPBACK }).pipe(Effect.provide(layer))))
      // The browser asks from a port of its own; its answers come there.
      const browser = yield* browse({ port: r.port, httpPort: 1, targets: [LOOPBACK, LOOPBACK], peers: null, probe: noProbe }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* arrivals(arrived, 2, r.port)
      yield* TestClock.adjust(WAIT)
      const found = yield* Fiber.join(browser)
      assert.isFalse(found.tailscale)
      assert.deepStrictEqual(found.hosts, [
        { host_id: HostId.make("h1"), name: "name-h1", url: "http://127.0.0.1:7999", via: "lan", version: "1.2.3", protocol: 1, capabilities: null },
      ])
    }).pipe(Effect.scoped),
  )

  it.effect("queries for other services, responses and nonsense get no answer", () =>
    Effect.gen(function* () {
      const { layer, arrived } = yield* loopbackUdp
      const r = Option.getOrThrow(Option.fromNullOr(yield* respond(Effect.succeed(ad("h1", 7999)), { port: 0, address: LOOPBACK }).pipe(Effect.provide(layer))))
      const q = yield* Effect.flatMap(Udp, (udp) => udp.bind(0, LOOPBACK)).pipe(Effect.provide(layer), Effect.orDie)
      yield* q.messages.pipe(Stream.runDrain, Effect.forkScoped)
      // The same length of name, for another service.
      const other = query()
      const at = new TextDecoder().decode(other).indexOf("_huntaway")
      other.set(new TextEncoder().encode("_otherone"), at)
      for (const m of [other, response(ad("x", 1), []), new TextEncoder().encode("x".repeat(600))]) yield* q.send(m, r.port, LOOPBACK)
      // Then a query it answers (with its id): the responder takes them in turn, so answers to the others would come first.
      yield* q.send(query(7), r.port, LOOPBACK)
      const [first] = yield* arrivals(arrived, 1, r.port)
      assert.strictEqual(first === undefined ? null : parse(first.data)?.id, 7)
    }).pipe(Effect.scoped),
  )

  it.effect("a Tailscale peer that doesn't answer mDNS is found on its HTTP port's health", () =>
    Effect.gen(function* () {
      const { layer } = yield* loopbackUdp
      // A UDP port nothing answers on.
      const quiet = yield* Effect.flatMap(Udp, (udp) => udp.bind(0, LOOPBACK)).pipe(Effect.provide(layer), Effect.orDie)
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const health: Probed = { host_id: "h9", version: "0.1.0", protocol: 1, capabilities: [] }
      const browser = yield* browse({
        port: quiet.port,
        httpPort: 7123,
        targets: [],
        peers: [{ name: "box", ip: LOOPBACK }],
        probe: (url) =>
          Effect.as(
            Ref.update(asked, (a) => [...a, url]),
            health,
          ),
      }).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust(WAIT)
      const found = yield* Fiber.join(browser)
      assert.isTrue(found.tailscale)
      assert.deepStrictEqual(yield* Ref.get(asked), ["http://127.0.0.1:7123"])
      assert.deepStrictEqual(found.hosts, [
        { host_id: HostId.make("h9"), name: "box", url: "http://127.0.0.1:7123", via: "tailscale", version: "0.1.0", protocol: 1, capabilities: [] },
      ])
    }).pipe(Effect.scoped),
  )

  it.effect("a Tailscale peer that answers mDNS isn't listed again from its HTTP port", () =>
    Effect.gen(function* () {
      const { layer, arrived } = yield* loopbackUdp
      const r = Option.getOrThrow(Option.fromNullOr(yield* respond(Effect.succeed(ad("h3", 7000)), { port: 0, address: LOOPBACK }).pipe(Effect.provide(layer))))
      const health: Probed = { host_id: "h3", version: "1.2.3", protocol: 1, capabilities: [] }
      const browser = yield* browse({
        port: r.port,
        httpPort: 7123,
        targets: [],
        peers: [{ name: "box", ip: LOOPBACK }],
        probe: () => Effect.succeed(health),
      }).pipe(Effect.provide(layer), Effect.forkChild)
      yield* arrivals(arrived, 1, r.port)
      yield* TestClock.adjust(WAIT)
      const found = yield* Fiber.join(browser)
      assert.deepStrictEqual(
        found.hosts.map((h) => [h.host_id, h.url, h.via]),
        [["h3", "http://127.0.0.1:7000", "tailscale"]],
      )
    }).pipe(Effect.scoped),
  )

  // A socket keeps memberships of interfaces that have gone until it closes, and has room for 20: it's renewed.
  it.effect("a responder renews its socket every so often, on the same port, and answers all along", () =>
    Effect.gen(function* () {
      const { layer, arrived } = yield* loopbackUdp
      const scope = yield* Scope.make()
      const r = Option.getOrThrow(
        Option.fromNullOr(yield* respond(Effect.succeed(ad("h4", 7004)), { port: 0, address: LOOPBACK }).pipe(Effect.provide(layer), Scope.provide(scope))),
      )
      const find = Effect.gen(function* () {
        const browser = yield* browse({ port: r.port, httpPort: 1, targets: [LOOPBACK], peers: null, probe: noProbe }).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        )
        yield* arrivals(arrived, 1, r.port)
        yield* TestClock.adjust(WAIT)
        return (yield* Fiber.join(browser)).hosts.map((h) => h.url)
      })
      for (let i = 1; i <= 3; i++) {
        const renewed = yield* SubscriptionRef.changes(r.renewed).pipe(
          Stream.filter((n) => n >= i),
          Stream.runHead,
          Effect.forkChild,
        )
        yield* TestClock.adjust("30 seconds")
        yield* Fiber.join(renewed)
        assert.deepStrictEqual(yield* find, ["http://127.0.0.1:7004"])
      }
      // Closed, it answers no more.
      yield* Scope.close(scope, Exit.void)
      const browser = yield* browse({ port: r.port, httpPort: 1, targets: [LOOPBACK], peers: null, probe: noProbe }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* TestClock.adjust(WAIT)
      assert.deepStrictEqual((yield* Fiber.join(browser)).hosts, [])
    }).pipe(Effect.scoped),
  )
})

/** A socket whose datagrams go out of the interface set when they go, a moment after they are sent. */
const fakeSocket = (incoming: Queue.Queue<UdpMessage>, out: Queue.Queue<string>): UdpSocket => {
  let iface = ""
  return {
    port: MDNS_PORT,
    messages: Stream.fromQueue(incoming),
    send: () => Effect.void,
    sendVia: (_data, _port, _group, via) =>
      Effect.gen(function* () {
        iface = via
        yield* Effect.yieldNow
        yield* Queue.offer(out, iface)
      }),
    join: () => Effect.void,
    setMulticastTtl: () => Effect.void,
  }
}

const iface = (address: string) => ({ address, family: "IPv4", internal: false })

describe("multicast, on a fake socket", () => {
  it.effect("multicast goes out of each network in turn, not all of it out of the last", () =>
    Effect.gen(function* () {
      const out = yield* Queue.unbounded<string>()
      yield* sendOut(fakeSocket(yield* Queue.unbounded<UdpMessage>(), out), query(), ["10.9.0.1", "10.9.1.1"])
      assert.deepStrictEqual(yield* Queue.clear(out), ["10.9.0.1", "10.9.1.1"])
    }),
  )

  it.effect("a responder's answers to queries that come together don't interleave", () =>
    Effect.gen(function* () {
      const out = yield* Queue.unbounded<string>()
      const incoming = yield* Queue.unbounded<UdpMessage>()
      const udp = Udp.of({
        interfaces: Effect.succeed({ eth0: [iface("10.9.0.1")], eth1: [iface("10.9.1.1")] }),
        bind: () => Effect.succeed(fakeSocket(incoming, out)),
      })
      yield* respond(Effect.succeed(ad("h5", 7005))).pipe(Effect.provideService(Udp, udp))
      // Two queries on the group at once.
      for (let i = 0; i < 2; i++) yield* Queue.offer(incoming, { data: query(), address: "10.9.0.7", port: MDNS_PORT })
      const sent = yield* Stream.fromQueue(out).pipe(Stream.take(4), Stream.runCollect)
      assert.deepStrictEqual(sent, ["10.9.0.1", "10.9.1.1", "10.9.0.1", "10.9.1.1"])
    }).pipe(Effect.scoped),
  )
})
