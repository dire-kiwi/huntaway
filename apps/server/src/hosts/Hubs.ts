import { Clock, Context, Deferred, Duration, Effect, FiberSet, Layer, Redacted, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { HttpServer } from "effect/http"
import { LINK_HEADER, SESSION_HEADER } from "@huntaway/contracts"
import type { LinkHello, OpenStream } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { About } from "../settings/About.ts"
import { helloOf, peerClient, wsUrl } from "./LinkConnections.ts"
import type { PeerClient } from "./LinkConnections.ts"
import { dial, pipe } from "./pipe.ts"
import { SessionSeal } from "./SessionSeal.ts"

// This host as a host of other hubs (`--hub URL[,URL] --hub-token T`; docs/plan/08-hosts.md, dial-in): for each hub,
// a control connection to its `/api/rpc` with the hub token (a session of `link` alone there), `link.hello`, then
// `link.attach` held open. For each `OpenStream` the hub sends, the host dials the hub's `/api/link/stream/<id>` and
// pipes it to its own `path` here, with the session the hub asked for sealed under this host's own token (the hub
// never holds it). Back-off doubles to 30 s and resets only after a connection that lasted a minute, so a hub that
// refuses at once is not redialled every second.

/** What may be asked for: this host's RPC, or a terminal by its ticket (the relay's own rule). */
const PATH = /^\/api\/(rpc|terminal\/[A-Za-z0-9_-]{1,200})$/

/** A hub this host is connected to: what it said, and its client (agents' board tools go up through it, 7.4). */
export interface Hub {
  readonly url: string
  readonly hello: LinkHello
  readonly client: PeerClient
}

/** A connection that lasted this long resets the back-off. */
const LASTED = Duration.minutes(1)

export class Hubs extends Context.Service<
  Hubs,
  {
    /** The hubs this host is connected to now, which said hello. */
    readonly connected: Effect.Effect<ReadonlyArray<Hub>>
    /** Dials every `--hub` for the scope, now that the server listens at `local` (`http://host:port`). */
    readonly start: (local: string) => Effect.Effect<void, never, Scope.Scope>
  }
>()("huntaway-server/hosts/Hubs") {
  /** Starts the dialling once the server listens: it pipes the hubs' sockets to its own address. */
  static readonly dialIn = Layer.effectDiscard(
    Effect.gen(function* () {
      const hubs = yield* Hubs
      const address = (yield* HttpServer.HttpServer).address
      if (address._tag === "UnixPathAddress") return
      // Listening on every address: this host reaches itself on loopback.
      yield* hubs.start(HttpServer.formatAddress(address).replace("//0.0.0.0:", "//127.0.0.1:").replace("//[::]:", "//[::1]:"))
    }),
  )

  static readonly layer = Layer.effect(
    Hubs,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const identity = yield* Identity
      const about = yield* About
      const seal = yield* SessionSeal
      const hubs = yield* Ref.make<ReadonlyMap<string, Hub>>(new Map())
      const hubToken = config.hubToken === null ? null : Redacted.value(config.hubToken)

      /** One socket the hub asked for, piped until either end closes. */
      const answer = (local: string, url: string, hub: LinkHello, request: OpenStream) =>
        Effect.gen(function* () {
          if (!PATH.test(request.path) || hubToken === null) return
          const sealed = yield* seal.seal(identity.token, request.session)
          const here = yield* dial(wsUrl(local, request.path), { headers: { [LINK_HEADER]: hub.host_id, [SESSION_HEADER]: sealed } })
          const there = yield* dial(wsUrl(url, `/api/link/stream/${request.id}`), { headers: { authorization: `Bearer ${hubToken}` } })
          yield* pipe(there, here)
        })

      /** One connection to the hub at `url`, until it ends. */
      const attempt = (local: string, url: string, token: string) =>
        Effect.gen(function* () {
          const disconnected = yield* Deferred.make<void>()
          const client = yield* peerClient(wsUrl(url, "/api/rpc"), {}, token, disconnected)
          const mine = helloOf(yield* about.info)
          const theirs = yield* client("link.hello", mine).pipe(Effect.timeout("10 seconds"))
          yield* Ref.update(hubs, (all) => new Map(all).set(url, { url, hello: theirs, client }))
          yield* Effect.addFinalizer(() =>
            Ref.update(hubs, (all) => {
              const next = new Map(all)
              next.delete(url)
              return next
            }),
          )
          const answers = yield* FiberSet.make()
          yield* Effect.logInfo(`dialled in to hub ${theirs.name} at ${url}`)
          yield* Effect.raceFirst(
            client("link.attach", mine).pipe(Stream.runForEach((request) => FiberSet.run(answers, answer(local, url, theirs, request).pipe(Effect.ignore)))),
            Deferred.await(disconnected),
          )
        }).pipe(Effect.scoped)

      /** Dials the hub at `url` for as long as the server runs. */
      const loop = (local: string, url: string, token: string) =>
        Effect.gen(function* () {
          let backoff = Duration.seconds(1)
          for (;;) {
            const started = yield* Clock.currentTimeMillis
            yield* attempt(local, url, token).pipe(
              Effect.catchTag("LinkRefused", (e) => Effect.logWarning(`hub ${url} refused this host: ${e.reason}`)),
              Effect.catch((e) => Effect.logInfo(`hub ${url}: ${e._tag === "TimeoutError" ? "no answer" : "can't reach it"}`)),
            )
            const lasted = (yield* Clock.currentTimeMillis) - started
            backoff = lasted >= Duration.toMillis(LASTED) ? Duration.seconds(1) : Duration.min(Duration.times(backoff, 2), Duration.seconds(30))
            yield* Effect.sleep(backoff)
          }
        })

      const start = Effect.fn("Hubs.start")(function* (local: string) {
        if (hubToken !== null) for (const url of config.hubs) yield* Effect.forkScoped(loop(local, url, hubToken))
        else if (config.hubs.length > 0) yield* Effect.logWarning("--hub is given without --hub-token: not dialling in")
      })

      return Hubs.of({ connected: Effect.map(Ref.get(hubs), (all) => [...all.values()]), start })
    }),
  )
}
