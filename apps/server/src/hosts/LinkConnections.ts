import { NodeWS } from "@effect/platform-node"
import { Clock, Context, Deferred, Duration, Effect, FiberMap, Layer, Option, Redacted, Ref, Schedule, Stream, SubscriptionRef } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import type { RpcClientError, RpcGroup } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, boardScopes, HostOffline, LINK_HEADER, PROTOCOL, PeerRpcs, SESSION_HEADER } from "@huntaway/contracts"
import type { AssertedSession, HostInfo, LinkHello, LinkId, LinkStatus, Timestamp } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { About } from "../settings/About.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { LinkRow } from "./LinkRepo.ts"
import { dial } from "./pipe.ts"
import type { Pipeable } from "./pipe.ts"
import { SessionSeal } from "./SessionSeal.ts"

// One live connection per linked host (docs/plan/08-hosts.md, A link is a control connection): for a link the hub
// dials, a websocket to the host's `/api/rpc` with a sealed session of kind `link`, `link.hello` both ways, the RPC
// client's ping (20 s; dead after 60 s with no frame from the peer: a proxy's pongs don't count), and back-off
// (1 s doubling to 30 s, from 1 s again after a connection that came up). Each link's loop is a fiber in a `FiberMap`
// keyed by its id: starting it again replaces it, forgetting the link interrupts it.

/** A linked host's RPC client: its own groups and `link.*`. */
export type PeerClient = RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof PeerRpcs>, RpcClientError.RpcClientError>

/** How a link looks now: the hub's directory shows it, `hub.hosts.watch` streams it. */
export interface LinkView {
  readonly status: LinkStatus
  /** Why it is offline or refused. */
  readonly reason: string | null
  /** What the host said of itself when it last connected. */
  readonly hello: LinkHello | null
  /** When the hub last heard from it (pings keep a live link's recent). */
  readonly last_message_at: Timestamp | null
  /** How this connection came: the hub dialled it, or it dialled in. */
  readonly via: "dialled" | "dial-in" | null
}

const initialView: LinkView = { status: "connecting", reason: null, hello: null, last_message_at: null, via: null }

/** A connection the hub can use: the host's client and what it said. */
export interface Live {
  readonly id: LinkId
  readonly hello: LinkHello
  readonly client: PeerClient
  readonly via: "dialled" | "dial-in"
  /** A socket to `path` on that host, carrying `session` (sealed for the host on the way). */
  readonly open: (path: string, session: AssertedSession) => Effect.Effect<Pipeable>
}

/** The RPC ping's interval and how long a link may be silent before it counts as dead. */
export const PING = "20 seconds"
export const SILENCE = "60 seconds"
/** How long `link.hello` may take. */
const HELLO_TIMEOUT = "10 seconds"
/** A link's own session lasts this long; a connection that outlives it is dialled again. */
const LINK_SESSION = Duration.days(7)

/** What this host says of itself in `link.hello`. */
export const helloOf = (info: HostInfo): LinkHello => ({
  host_id: info.host_id,
  name: info.host_name,
  protocol: info.protocol,
  version: info.version,
  capabilities: info.capabilities,
  commit: info.commit,
  agents: info.agents,
  updates_from: info.updates_from,
})

/** `http(s)://…` as the websocket URL of `path` there. */
export const wsUrl = (url: string, path: string) => `${url.replace(/\/+$/, "").replace(/^http/, "ws")}${path}`

/**
 * An RPC client for `PeerRpcs` over a websocket to `url` with `headers` on its upgrade request and `token` on each
 * request, in the current scope; `disconnected` is done when its connection ends (or never came up).
 */
export const peerClient = (url: string, headers: Readonly<Record<string, string>>, token: string, disconnected: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.void,
      onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
    })
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket({ pingInterval: PING, pingTimeout: SILENCE, retryPolicy: Schedule.recurs(0) }).pipe(
          Layer.provide(Socket.layerWebSocket(url, { headers, openTimeout: "30 seconds" })),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(hooks),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
      ),
    )
    return yield* RpcClient.make(PeerRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

export class LinkConnections extends Context.Service<
  LinkConnections,
  {
    /** Connects to `link` (a link the hub dials), replacing any connection it had. */
    readonly start: (link: LinkRow) => Effect.Effect<void>
    /** Ends `id`'s connection and forgets its state. */
    readonly stop: (id: LinkId) => Effect.Effect<void>
    /** Every link's state now. */
    readonly views: Effect.Effect<ReadonlyMap<LinkId, LinkView>>
    /** Something about the hosts changed: a link's state, or (`touch`) the links themselves. */
    readonly changes: Stream.Stream<void>
    /** Tells `changes` that the links themselves changed. */
    readonly touch: Effect.Effect<void>
    /** The live connection to `id`, or `HostOffline`. */
    readonly live: (id: LinkId) => Effect.Effect<Live, HostOffline>
    /** Every live connection. */
    readonly connected: Effect.Effect<ReadonlyArray<Live>>
  }
>()("huntaway-server/hosts/LinkConnections") {
  static readonly layer = Layer.effect(
    LinkConnections,
    Effect.gen(function* () {
      const repo = yield* LinkRepo
      const seal = yield* SessionSeal
      const about = yield* About
      const identity = yield* Identity
      const fibers = yield* FiberMap.make<LinkId>()
      const views = yield* SubscriptionRef.make<ReadonlyMap<LinkId, LinkView>>(new Map())
      const lives = yield* Ref.make<ReadonlyMap<LinkId, Live>>(new Map())
      const bumps = yield* SubscriptionRef.make(0)

      const setView = (id: LinkId, change: (view: LinkView) => LinkView) =>
        SubscriptionRef.update(views, (all) => new Map(all).set(id, change(all.get(id) ?? initialView)))
      const nameOf = (id: LinkId) => Effect.map(repo.get(id), (row) => row?.name ?? id)

      /** One connection to a link the hub dials, until it ends: whether it came up. */
      const attempt = (link: LinkRow) =>
        Effect.gen(function* () {
          const url = link.url
          const token = link.token
          if (url === null || token === null) {
            yield* setView(link.id, (v) => ({ ...v, status: "refused", reason: "the link has no URL or token" }))
            return false
          }
          yield* setView(link.id, (v) => ({ ...v, status: "connecting", reason: null }))
          const now = yield* Clock.currentTimeMillis
          const sealed = yield* seal.seal(Redacted.make(token), {
            kind: "link",
            scopes: [...boardScopes, "link"],
            device_id: null,
            exp: now + Duration.toMillis(LINK_SESSION),
          })
          const disconnected = yield* Deferred.make<void>()
          const client = yield* peerClient(wsUrl(url, "/api/rpc"), { [LINK_HEADER]: identity.hostId, [SESSION_HEADER]: sealed }, token, disconnected)
          const mine = helloOf(yield* about.info)
          const theirs = yield* client("link.hello", mine).pipe(Effect.timeoutOption(HELLO_TIMEOUT), Effect.result)
          if (theirs._tag === "Failure" || Option.isNone(theirs.success)) {
            const error = theirs._tag === "Failure" ? theirs.failure : null
            const reason =
              error === null
                ? "it didn't answer in time"
                : error._tag === "LinkRefused"
                  ? error.reason
                  : error._tag === "Unauthorized"
                    ? "it didn't accept this hub's token for it; link it again"
                    : "can't reach it"
            const refused = error?._tag === "LinkRefused" || error?._tag === "Unauthorized"
            yield* setView(link.id, (v) => ({ ...v, status: refused ? "refused" : "offline", reason }))
            return false
          }
          const hello = theirs.success.value
          if (String(hello.host_id) !== String(link.id)) {
            yield* setView(link.id, (v) => ({ ...v, status: "refused", reason: `it answers as another host (${hello.host_id})` }))
            return false
          }
          const live: Live = {
            id: link.id,
            hello,
            client,
            via: "dialled",
            open: (path, session) =>
              Effect.flatMap(seal.seal(Redacted.make(token), session), (value) =>
                dial(wsUrl(url, path), { headers: { [LINK_HEADER]: identity.hostId, [SESSION_HEADER]: value, authorization: `Bearer ${token}` } }),
              ),
          }
          // A dialled connection replaces whatever is registered for its host.
          yield* Ref.update(lives, (all) => new Map(all).set(link.id, live))
          const heard = yield* nowTimestamp
          yield* setView(link.id, () => ({
            status: hello.protocol === PROTOCOL ? "connected" : "needs_update",
            reason: hello.protocol === PROTOCOL ? null : `it speaks protocol ${hello.protocol}, this hub ${PROTOCOL}`,
            hello,
            last_message_at: heard,
            via: "dialled",
          }))
          yield* Effect.logInfo(`connected to host ${link.name}`)
          // The RPC client's ping ends a connection that is silent for a minute, so a live one was heard from within one
          // ping: the time shown follows the pings.
          yield* nowTimestamp.pipe(
            Effect.flatMap((at) => setView(link.id, (v) => ({ ...v, last_message_at: at }))),
            Effect.delay(PING),
            Effect.forever,
            Effect.forkScoped,
          )
          yield* Deferred.await(disconnected)
          yield* Effect.logInfo(`lost host ${link.name}`)
          return true
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const was = (yield* Ref.get(lives)).get(link.id)
              if (was?.via !== "dialled") return
              yield* Ref.update(lives, (all) => {
                const next = new Map(all)
                next.delete(link.id)
                return next
              })
              const view = (yield* SubscriptionRef.get(views)).get(link.id)
              if (view?.last_message_at) yield* repo.setLastSeen(link.id, view.last_message_at)
              yield* setView(link.id, (v) => ({ ...v, status: v.status === "connected" || v.status === "needs_update" ? "offline" : v.status, via: null }))
            }),
          ),
          Effect.scoped,
        )

      /** Dials `link` for as long as the hub keeps it, backing off between failures. */
      const loop = (link: LinkRow) =>
        Effect.gen(function* () {
          let backoff = Duration.seconds(1)
          for (;;) {
            const cameUp = yield* attempt(link).pipe(Effect.catchCause((cause) => Effect.as(Effect.logDebug(`link ${link.name}`, cause), false)))
            backoff = cameUp ? Duration.seconds(1) : Duration.min(Duration.times(backoff, 2), Duration.seconds(30))
            yield* Effect.sleep(cameUp ? Duration.seconds(1) : backoff)
          }
        })

      const start = Effect.fn("LinkConnections.start")(function* (link: LinkRow) {
        yield* setView(link.id, () => initialView)
        yield* FiberMap.run(fibers, link.id, loop(link))
      })

      const stop = Effect.fn("LinkConnections.stop")(function* (id: LinkId) {
        yield* FiberMap.remove(fibers, id)
        yield* Ref.update(lives, (all) => {
          const next = new Map(all)
          next.delete(id)
          return next
        })
        yield* SubscriptionRef.update(views, (all) => {
          const next = new Map(all)
          next.delete(id)
          return next
        })
      })

      // Every link the hub dials is dialled from the start.
      for (const link of yield* repo.list) if (link.mode === "outbound") yield* start(link)

      return LinkConnections.of({
        start,
        stop,
        views: SubscriptionRef.get(views),
        changes: Stream.merge(SubscriptionRef.changes(views), SubscriptionRef.changes(bumps)).pipe(Stream.as(undefined)),
        touch: SubscriptionRef.update(bumps, (n) => n + 1),
        live: (id) =>
          Effect.flatMap(Ref.get(lives), (all) => {
            const live = all.get(id)
            return live === undefined
              ? Effect.flatMap(nameOf(id), (name) => Effect.fail(new HostOffline({ host_id: id, host_name: name })))
              : Effect.succeed(live)
          }),
        connected: Effect.map(Ref.get(lives), (all) => [...all.values()]),
      })
    }),
  )
}
