import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { PROTOCOL } from "@huntaway/contracts"
import type { FoundHost, Host } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { browse, respond } from "./discovery/mdns.ts"
import type { Probed } from "./discovery/mdns.ts"
import type { Found } from "./discovery/dns.ts"
import { Tailscale } from "./discovery/Tailscale.ts"
import { Udp } from "./discovery/Udp.ts"
import { LinkConnections } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { LinkRow } from "./LinkRepo.ts"

// Finding other hosts, for Settings → Hosts to offer linking them (docs/plan/08-hosts.md; inventory 05 §2.4): this host
// advertises itself over mDNS (`Discovery.responder`), and a hub browses the LAN, asks its Tailscale peers directly (and
// on their HTTP port), and asks the hosts it links for the hosts they link (a mesh, one hop). `--no-discovery` (test
// servers) neither answers nor sends mDNS queries, nor asks Tailscale: only the mesh, which goes through links.

/** How long a linked host has to list its hosts, and a host found that way to answer on its health. */
export const MESH_TIMEOUT = Duration.seconds(4)
/** The port Tailscale peers are tried on when this host took a free one: the default. */
const DEFAULT_PORT = 7879

const Health = Schema.Struct({
  ok: Schema.Literal(true),
  host_id: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  protocol: Schema.optional(Schema.NullOr(Schema.Int)),
  capabilities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
})
const decodeHealth = Schema.decodeUnknownEffect(Schema.fromJsonString(Health))

/** No hosts found nearby. */
const none: ReadonlyArray<Found> = []

/** A URL without its trailing slashes. */
const bare = (url: string) => url.replace(/\/+$/, "")

/** `hosts` without this host, each marked `linked` if it is linked here already (by its id, or by its URL). */
export const markDiscovered = (me: string, links: ReadonlyArray<LinkRow>, hosts: ReadonlyArray<Found>): Array<FoundHost> => {
  const ids = new Set<string>(links.map((l) => l.id))
  const urls = new Set(links.flatMap((l) => (l.url === null ? [] : [bare(l.url)])))
  return hosts
    .filter((h) => h.host_id !== me)
    .map((h): FoundHost => Object.assign({}, h, { linked: (h.host_id !== null && ids.has(h.host_id)) || urls.has(h.url) }))
}

/**
 * The hosts a linked host links by an http(s) URL, as candidates: not this host, not linked here, each once. An SSH link's
 * target (`ssh://…`) isn't a URL to link by.
 */
export const meshCandidates = (
  me: string,
  linked: ReadonlySet<string>,
  lists: ReadonlyArray<{ readonly through: string; readonly hosts: ReadonlyArray<Host> }>,
): Array<{ readonly through: string; readonly host: Host; readonly url: string }> => {
  const seen = new Set<string>()
  const out: Array<{ readonly through: string; readonly host: Host; readonly url: string }> = []
  for (const { through, hosts } of lists) {
    for (const host of hosts) {
      if (host.local || host.url === null || host.id === me || linked.has(host.id) || seen.has(host.id)) continue
      if (!/^https?:\/\/[^/]/.test(host.url)) continue
      seen.add(host.id)
      out.push({ through, host, url: bare(host.url) })
    }
  }
  return out
}

export interface DiscoveryShape {
  /**
   * Hosts on the LAN and Tailscale, and those the linked hosts link, but not this one: each with `linked` if it's linked
   * already. `tailscale` is whether Tailscale is up here.
   */
  readonly discover: Effect.Effect<{ readonly tailscale: boolean; readonly hosts: ReadonlyArray<FoundHost> }>
  /** What `url` says on `/api/health`, if it answers as a host does. */
  readonly probe: (url: string, timeout: Duration.Input) => Effect.Effect<Probed | null>
}

export class Discovery extends Context.Service<Discovery, DiscoveryShape>()("huntaway-server/hosts/Discovery") {
  static readonly layer = Layer.effect(
    Discovery,
    Effect.gen(function* () {
      const udp = yield* Udp
      const tailscale = yield* Tailscale
      const http = yield* HttpClient.HttpClient
      const connections = yield* LinkConnections
      const repo = yield* LinkRepo
      const identity = yield* Identity
      const config = yield* ServerConfig
      const me: string = identity.hostId

      const probe = (url: string, timeout: Duration.Input) =>
        http.execute(HttpClientRequest.get(`${bare(url)}/api/health`)).pipe(
          Effect.flatMap((res) => (res.status === 200 ? res.text : Effect.succeed(""))),
          Effect.flatMap(decodeHealth),
          Effect.map((h): Probed => ({
            host_id: h.host_id ?? null,
            version: h.version ?? null,
            protocol: h.protocol ?? null,
            capabilities: h.capabilities ?? [],
          })),
          Effect.timeoutOption(timeout),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        )

      /**
       * The hosts that the connected linked hosts link by URL (their `hub.hosts.list`), that aren't linked here, and that
       * answer here at that URL as that host: a mesh, so that linking one host over Tailscale, where mDNS doesn't go,
       * finds the others it links. One hop: their own links' links aren't asked. Their tokens stay with them: linking one
       * still takes its token.
       */
      const throughLinks = Effect.gen(function* () {
        const rows = yield* repo.list
        const names = new Map<string, string>(rows.map((r) => [r.id, r.name]))
        const lives = (yield* connections.connected).filter((live) => live.hello.protocol === PROTOCOL)
        const lists = yield* Effect.forEach(
          lives,
          (live) =>
            live.client("hub.hosts.list", undefined).pipe(
              Effect.timeoutOption(MESH_TIMEOUT),
              Effect.map((hosts) => ({ through: names.get(live.id) ?? live.hello.name, hosts: Option.getOrElse(hosts, () => []) })),
              Effect.orElseSucceed(() => ({ through: live.hello.name, hosts: [] })),
            ),
          { concurrency: "unbounded" },
        )
        const candidates = meshCandidates(me, new Set(names.keys()), lists)
        const found = yield* Effect.forEach(
          candidates,
          ({ through, host, url }) =>
            Effect.map(probe(url, MESH_TIMEOUT), (p): Array<Found> =>
              // Not reachable from here, or another host at that address here (on a private network with the same
              // addresses, or on loopback, which is each machine's own).
              p === null || p.host_id !== host.id
                ? []
                : [{ host_id: host.id, name: host.name, url, via: "mesh", through, version: host.version, protocol: p.protocol, capabilities: p.capabilities }],
            ),
          { concurrency: "unbounded" },
        )
        return found.flat()
      })

      /** Nearby hosts over mDNS and Tailscale: none on a test server. */
      const nearby = config.noDiscovery
        ? Effect.succeed({ hosts: none, tailscale: false })
        : Effect.gen(function* () {
            const peers = yield* tailscale.peers
            return yield* browse({ httpPort: config.port === 0 ? DEFAULT_PORT : config.port, peers, probe })
          }).pipe(Effect.provideService(Udp, udp))

      const discover = Effect.gen(function* () {
        const [{ hosts, tailscale: up }, meshed] = yield* Effect.all([nearby, throughLinks], { concurrency: 2 })
        // One found nearby is listed as such, not again as one a linked host links.
        const ids = new Set(hosts.flatMap((h) => (h.host_id === null ? [] : [h.host_id])))
        const urls = new Set(hosts.map((h) => h.url))
        const all = [...hosts, ...meshed.filter((h) => !(h.host_id !== null && ids.has(h.host_id)) && !urls.has(h.url))]
        return { tailscale: up, hosts: markDiscovered(me, yield* repo.list, all) }
      }).pipe(Effect.withSpan("Discovery.discover"))

      return Discovery.of({ discover, probe })
    }),
  )

  /**
   * Advertises this host on mDNS while the server runs, once it listens: not with `--no-discovery` (test servers), nor
   * on a host only this machine can reach, which has nothing to tell the network.
   */
  static readonly responder = Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const identity = yield* Identity
      const server = yield* HttpServer.HttpServer
      const loopbackOnly = ["127.0.0.1", "::1", "localhost"].includes(config.host) || config.host.startsWith("127.")
      if (config.noDiscovery || loopbackOnly || server.address._tag === "UnixPathAddress") return
      // One IPv4 address it listens on only (the advertisement is IPv4), rather than all of them.
      const address = /^\d+\.\d+\.\d+\.\d+$/.test(config.host) && config.host !== "0.0.0.0" ? config.host : undefined
      const ad = {
        host_id: identity.hostId,
        host_name: identity.hostName,
        port: server.address.port,
        address,
        version: config.version,
        protocol: PROTOCOL,
      }
      const started = yield* respond(Effect.succeed(ad))
      if (started === null) yield* Effect.logWarning("discovery: can't answer on UDP 5353; other hosts won't find this one")
    }),
  )
}
