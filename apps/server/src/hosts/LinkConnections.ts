import { NodeWS } from "@effect/platform-node"
import { Clock, Context, Deferred, Duration, Effect, FiberMap, Latch, Layer, Option, Queue, Redacted, Ref, Schedule, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import type { Rpc, RpcClientError, RpcGroup } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, boardScopes, HostOffline, LinkId, LinkRefused, LINK_HEADER, PROTOCOL, PeerRpcs, SESSION_HEADER } from "@huntaway/contracts"
import type { AssertedSession, HostInfo, LinkHello, LinkStatus, OpenStream, SessionShape, Timestamp } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { About } from "../settings/About.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { LinkRow } from "./LinkRepo.ts"
import { dial } from "./pipe.ts"
import type { Pipeable } from "./pipe.ts"
import { SessionSeal } from "./SessionSeal.ts"
import { Ssh } from "./Ssh.ts"

// One live connection per linked host (docs/plan/08-hosts.md, A link is a control connection; inventory 05 §2.2, §9).
//
// - A link the hub dials (`outbound`, and `ssh` through a tunnel): a websocket to the host's `/api/rpc` with a sealed
//   session of kind `link`, `link.hello` both ways, the RPC client's ping (20 s; dead after 60 s with no frame from the
//   peer, so a proxy's pongs don't count), back-off from 1 s doubling to 30 s, from 1 s again after a connection that
//   came up. Each link's loop is a fiber in a `FiberMap` keyed by its id: starting it again replaces it, forgetting the
//   link interrupts it.
// - A host that dials in (`inbound`, with the hub token): it holds `link.attach` open, saying who it is; the hub asks
//   it for sockets through that stream (`OpenStream`), and the host answers each on `/api/link/stream/<id>`. The hub's
//   RPC client for it runs over such a socket, a new one on each reconnect.
//
// The trust rules, kept exactly (inventory 05 §9): a dial-in host is known only by the id it claims behind the hub
// token every such host shares, so a dial-in is refused under an id already connected (either way), and under the id
// of a profile's assistant host the hub dials even while that link is down; a dialled connection replaces whatever is
// registered (a dial-in that stood in for it while it was down).

/** A linked host's RPC client: its own groups and `link.*`. */
export type PeerClient = RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof PeerRpcs>, RpcClientError.RpcClientError>

/** How a connection came: the hub dialled it, or it dialled in. */
export type Via = "dialled" | "dial-in"

/** How a link looks now: the hub's directory shows it, `hub.hosts.watch` streams it. */
export interface LinkView {
  readonly status: LinkStatus
  /** Why it is offline or refused. */
  readonly reason: string | null
  /** What the host said of itself when it last connected. */
  readonly hello: LinkHello | null
  /** When the hub last heard from it (pings keep a live link's recent). */
  readonly last_message_at: Timestamp | null
  readonly via: Via | null
}

const initialView: LinkView = { status: "connecting", reason: null, hello: null, last_message_at: null, via: null }

/** A connection the hub can use: the host's client and what it said. */
export interface Live {
  readonly id: LinkId
  readonly hello: LinkHello
  readonly client: PeerClient
  readonly via: Via
  /** A socket to `path` on that host carrying `session` (sealed for the host on the way), for the scope. */
  readonly open: (path: string, session: AssertedSession) => Effect.Effect<Pipeable, HostOffline, Scope.Scope>
}

interface Registered extends Live {
  /** Ends this connection with `reason` (a dialled one taking its place, the link forgotten). */
  readonly drop: (reason: string) => Effect.Effect<void>
}

/** A socket a dial-in host opened for a request of the hub's, handed to whoever asked; `done` once they are finished. */
interface Handoff {
  readonly end: Pipeable
  readonly done: Deferred.Deferred<void>
}

/** `all` without `key`. */
const without = <K, V>(all: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(all)
  next.delete(key)
  return next
}

/** The RPC ping's interval and how long a link may be silent before it counts as dead. */
export const PING = "20 seconds"
export const SILENCE = "60 seconds"
/** How long `link.hello` may take, and a dial-in host to answer a request for a socket. */
const HELLO_TIMEOUT = "10 seconds"
const STREAM_TIMEOUT = "30 seconds"
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

/** The hub's own session on a host: every board scope and `link`. */
const linkSession = (now: number): AssertedSession => ({
  kind: "link",
  scopes: [...boardScopes, "link"],
  device_id: null,
  exp: now + Duration.toMillis(LINK_SESSION),
})

const authHeader = (token: string) =>
  RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }))

/**
 * An RPC client for `PeerRpcs` over `socket`, with `token` on each request, in the current scope. `disconnected` is
 * done when its connection ends (or never came up), unless `retry` (it then reconnects by itself).
 */
const clientOver = <E>(socket: Layer.Layer<Socket.Socket, E>, token: string, disconnected: Deferred.Deferred<void> | null) =>
  Effect.gen(function* () {
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.void,
      onDisconnect: disconnected === null ? Effect.void : Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
    })
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket({ pingInterval: PING, pingTimeout: SILENCE, ...(disconnected === null ? {} : { retryPolicy: Schedule.recurs(0) }) }).pipe(
          Layer.provide(socket),
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(hooks),
        ),
        authHeader(token),
      ),
    )
    return yield* RpcClient.make(PeerRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/**
 * An RPC client for `PeerRpcs` over a websocket to `url` with `headers` on its upgrade request and `token` on each
 * request, in the current scope; `disconnected` is done when its connection ends (or never came up).
 */
export const peerClient = (url: string, headers: Readonly<Record<string, string>>, token: string, disconnected: Deferred.Deferred<void>) =>
  clientOver(Socket.layerWebSocket(url, { headers, openTimeout: "30 seconds" }).pipe(Layer.provide(NodeWS.layerWebSocketConstructor)), token, disconnected)

const socketError = (cause: unknown) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })

/** A socket that asks `open` for a new connection each time it is (re)opened: the hub's way to a dial-in host's RPC. */
const reopening = (open: Effect.Effect<Pipeable, HostOffline, Scope.Scope>): Effect.Effect<Socket.Socket> =>
  Effect.gen(function* () {
    const box: { current: Pipeable | undefined } = { current: undefined }
    const ready = yield* Latch.make(false)
    const current = Effect.flatMap(ready.await, () => (box.current === undefined ? Effect.fail(socketError("not connected")) : Effect.succeed(box.current)))
    return Socket.make({
      reader: Effect.gen(function* () {
        const end = yield* open.pipe(Effect.mapError(socketError))
        const reader = yield* end.socket.reader
        box.current = end
        yield* ready.open
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            ready.close,
            Effect.sync(() => {
              box.current = undefined
            }),
          ),
        )
        return reader
      }),
      writer: Effect.succeed({
        write: (chunk) => Effect.flatMap(current, (end) => Effect.scoped(Effect.flatMap(end.socket.writer, (w) => w.write(chunk)))),
        writeAll: (chunks) => Effect.flatMap(current, (end) => Effect.scoped(Effect.flatMap(end.socket.writer, (w) => w.writeAll(chunks)))),
      }),
    })
  })

export class LinkConnections extends Context.Service<
  LinkConnections,
  {
    /** Connects to `link` (a link the hub dials, by URL or over SSH), replacing any connection it had. */
    readonly start: (link: LinkRow) => Effect.Effect<void>
    /** Ends `id`'s connection, whichever way it came, and forgets its state. */
    readonly stop: (id: LinkId) => Effect.Effect<void>
    /**
     * A host dialling in, saying `hello`, with the hub token (`session`): the requests for sockets the hub makes of it,
     * until either end goes. Refused as the trust rules say. `over` is the RPC connection it came on: while the host is
     * registered, `dialInOver` gives it for that connection (its board tool calls up come on it, 7.4).
     */
    readonly attach: (hello: LinkHello, session: SessionShape, over?: Rpc.ServerClient) => Stream.Stream<OpenStream, LinkRefused>
    /** The dial-in host registered by `attach` on RPC connection `over`, while it is the registered one for its id. */
    readonly dialInOver: (over: Rpc.ServerClient) => Effect.Effect<Option.Option<Live>>
    /** The socket a dial-in host opened for request `id`: who is waiting for it, if anyone. */
    readonly arrived: (id: string) => Effect.Effect<Option.Option<Deferred.Deferred<Handoff>>>
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
      const ssh = yield* Ssh
      const events = yield* Events
      const random = yield* SecureRandom.SecureRandom
      const fibers = yield* FiberMap.make<LinkId>()
      const views = yield* SubscriptionRef.make<ReadonlyMap<LinkId, LinkView>>(new Map())
      const lives = yield* Ref.make<ReadonlyMap<LinkId, Registered>>(new Map())
      const handoffs = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<Handoff>>>(new Map())
      // The dial-in hosts by the RPC connection they attached on.
      const attachedOn = yield* Ref.make<ReadonlyMap<Rpc.ServerClient, Registered>>(new Map())
      const bumps = yield* SubscriptionRef.make(0)

      const setView = (id: LinkId, change: (view: LinkView) => LinkView) =>
        SubscriptionRef.update(views, (all) => new Map(all).set(id, change(all.get(id) ?? initialView)))
      const nameOf = (id: LinkId) => Effect.map(repo.get(id), (row) => row?.name ?? id)
      const offline = (id: LinkId) => Effect.flatMap(nameOf(id), (name) => Effect.fail(new HostOffline({ host_id: id, host_name: name })))

      /** Connected (or `needs_update`): its state, and its heard time kept current while it lasts (scoped). */
      const connectedView = (id: LinkId, hello: LinkHello, via: Via) =>
        Effect.gen(function* () {
          const heard = yield* nowTimestamp
          yield* setView(id, () => ({
            status: hello.protocol === PROTOCOL ? "connected" : "needs_update",
            reason: hello.protocol === PROTOCOL ? null : `it speaks protocol ${hello.protocol}, this hub ${PROTOCOL}`,
            hello,
            last_message_at: heard,
            via,
          }))
          // The RPC client's ping ends a connection that is silent for a minute, so a live one was heard from within one
          // ping: the time shown follows the pings.
          yield* nowTimestamp.pipe(
            Effect.flatMap((at) => setView(id, (v) => ({ ...v, last_message_at: at }))),
            Effect.delay(PING),
            Effect.forever,
            Effect.forkScoped,
          )
        })

      /** When `live` ends: unregistered if still the registered one, `last_seen` written, shown offline. */
      const unregister = (live: Registered) =>
        Effect.gen(function* () {
          const was = yield* Ref.modify(lives, (all): [boolean, ReadonlyMap<LinkId, Registered>] =>
            all.get(live.id) === live ? [true, without(all, live.id)] : [false, all],
          )
          if (!was) return
          const view = (yield* SubscriptionRef.get(views)).get(live.id)
          if (view?.last_message_at) yield* repo.setLastSeen(live.id, view.last_message_at)
          yield* setView(live.id, (v) => ({ ...v, status: v.status === "refused" ? v.status : "offline", via: null }))
        })

      /** One connection to a host the hub dials at `url` with `token`, until it ends: whether it came up. */
      const dialled = (link: LinkRow, url: string, token: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const sealed = yield* seal.seal(Redacted.make(token), linkSession(now))
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
          const live: Registered = {
            id: link.id,
            hello,
            client,
            via: "dialled",
            open: (path, session) =>
              Effect.flatMap(seal.seal(Redacted.make(token), session), (value) =>
                dial(wsUrl(url, path), { headers: { [LINK_HEADER]: identity.hostId, [SESSION_HEADER]: value, authorization: `Bearer ${token}` } }),
              ),
            drop: () => Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
          }
          // A dialled connection replaces whatever is registered for its host (a dial-in standing in for it).
          const before = yield* Ref.modify(lives, (all): [Registered | undefined, ReadonlyMap<LinkId, Registered>] => [
            all.get(link.id),
            new Map(all).set(link.id, live),
          ])
          if (before !== undefined && before !== live) yield* before.drop(`${identity.hostName} dials ${link.name} itself again`)
          yield* Effect.addFinalizer(() => unregister(live))
          yield* connectedView(link.id, hello, "dialled")
          yield* Effect.logInfo(`connected to host ${link.name}`)
          yield* Deferred.await(disconnected)
          yield* Effect.logInfo(`lost host ${link.name}`)
          return true
        }).pipe(Effect.scoped)

      /** One connection to an SSH host: its forced command, a tunnel, then as a dialled host through it. */
      const overSsh = (link: LinkRow) =>
        Effect.gen(function* () {
          const target = link.ssh
          if (target === null) {
            yield* setView(link.id, (v) => ({ ...v, status: "refused", reason: "the link has no SSH target" }))
            return false
          }
          const details = yield* ssh.details(target, false)
          if (details.token !== link.token) yield* repo.setToken(link.id, details.token)
          const tunnel = yield* ssh.tunnel(target, details.port)
          return yield* Effect.raceFirst(dialled(link, `http://127.0.0.1:${tunnel.port}`, details.token), Effect.as(tunnel.exited, false))
        }).pipe(
          Effect.catchTag("Unavailable", (e) =>
            Effect.as(
              setView(link.id, (v) => ({ ...v, status: "offline", reason: e.reason })),
              false,
            ),
          ),
          Effect.scoped,
        )

      /** One connection to `link`, as its mode says. */
      const attempt = (link: LinkRow): Effect.Effect<boolean> => {
        if (link.mode === "ssh") return overSsh(link)
        if (link.url === null || link.token === null)
          return Effect.as(
            setView(link.id, (v) => ({ ...v, status: "refused", reason: "the link has no URL or token" })),
            false,
          )
        return dialled(link, link.url, link.token)
      }

      /** Dials `link` for as long as the hub keeps it, backing off between failures. */
      const loop = (link: LinkRow) =>
        Effect.gen(function* () {
          let backoff = Duration.seconds(1)
          for (;;) {
            yield* setView(link.id, (v) => ({ ...v, status: v.status === "refused" ? v.status : "connecting" }))
            const cameUp = yield* attempt(link).pipe(Effect.catchCause((cause) => Effect.as(Effect.logDebug(`link ${link.name}`, cause), false)))
            backoff = cameUp ? Duration.seconds(1) : Duration.min(Duration.times(backoff, 2), Duration.seconds(30))
            yield* Effect.sleep(backoff)
          }
        })

      const start = Effect.fn("LinkConnections.start")(function* (link: LinkRow) {
        yield* setView(link.id, () => initialView)
        yield* FiberMap.run(fibers, link.id, loop(link))
      })

      const stop = Effect.fn("LinkConnections.stop")(function* (id: LinkId) {
        yield* FiberMap.remove(fibers, id)
        const live = (yield* Ref.get(lives)).get(id)
        if (live !== undefined) yield* live.drop("removed from the hub")
        yield* Ref.update(lives, (all) => without(all, id))
        yield* SubscriptionRef.update(views, (all) => without(all, id))
      })

      /** Why a dial-in under `hello`'s id is refused, if it is. */
      const refusal = Effect.fn(function* (hello: LinkHello, session: SessionShape) {
        if (session.kind !== "link" || session.via_link !== null) return "a host dials in with the hub token"
        if (hello.host_id === identity.hostId) return "a host can't link to itself"
        const id = LinkId.make(hello.host_id)
        if ((yield* Ref.get(lives)).has(id)) return `host ${hello.host_id} is already connected to this hub`
        const row = yield* repo.get(id)
        if (row !== null && row.mode !== "inbound" && (yield* repo.assistantHosts).has(id))
          return `${identity.hostName} links assistant host ${row.name} itself, so a host that dials in under its id (${id}) isn't taken for it`
        return null
      })

      const attach = (hello: LinkHello, session: SessionShape, over?: Rpc.ServerClient): Stream.Stream<OpenStream, LinkRefused> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const refused = yield* refusal(hello, session)
            if (refused !== null) return yield* new LinkRefused({ reason: refused })
            const id = LinkId.make(hello.host_id)
            yield* repo.upsert({ id, name: hello.name, mode: "inbound", url: null, token: null, ssh: null, now: yield* nowTimestamp })
            const requests = yield* Queue.unbounded<OpenStream>()
            const dropped = yield* Deferred.make<string>()
            /** A socket to `path` on the host: asked for on the stream, answered on `/api/link/stream/<id>`. */
            const open = (path: string, asserted: AssertedSession) =>
              Effect.gen(function* () {
                if (yield* Deferred.isDone(dropped)) return yield* offline(id)
                const streamId = Hex.encode(yield* random.randomBytes(24))
                const handoff = yield* Deferred.make<Handoff>()
                yield* Ref.update(handoffs, (all) => new Map(all).set(streamId, handoff))
                yield* Effect.addFinalizer(() => Ref.update(handoffs, (all) => without(all, streamId)))
                yield* Queue.offer(requests, { id: streamId, path, session: asserted })
                const arrived = yield* Deferred.await(handoff).pipe(Effect.timeoutOption(STREAM_TIMEOUT))
                if (Option.isNone(arrived)) return yield* offline(id)
                yield* Effect.addFinalizer(() => Deferred.succeed(arrived.value.done, undefined))
                return arrived.value.end
              })
            const client = yield* clientOver(
              Layer.effect(Socket.Socket, reopening(Effect.flatMap(Clock.currentTimeMillis, (now) => open("/api/rpc", linkSession(now))))),
              "",
              null,
            )
            const live: Registered = { id, hello, client, via: "dial-in", open, drop: (reason) => Deferred.succeed(dropped, reason).pipe(Effect.asVoid) }
            const registered = yield* Ref.modify(lives, (all): [boolean, ReadonlyMap<LinkId, Registered>] =>
              all.has(id) ? [false, all] : [true, new Map(all).set(id, live)],
            )
            if (!registered) return yield* new LinkRefused({ reason: `host ${hello.host_id} is already connected to this hub` })
            yield* Effect.addFinalizer(() => unregister(live))
            if (over !== undefined) {
              yield* Ref.update(attachedOn, (all) => new Map(all).set(over, live))
              yield* Effect.addFinalizer(() => Ref.update(attachedOn, (all) => without(all, over)))
            }
            yield* connections.touch
            yield* connectedView(id, hello, "dial-in")
            yield* Effect.logInfo(`host ${hello.name} connected in`)
            return Stream.fromQueue(requests).pipe(
              Stream.interruptWhen(Effect.flatMap(Deferred.await(dropped), (reason) => Effect.fail(new LinkRefused({ reason })))),
            )
          }),
        )

      const connections = {
        start,
        stop,
        attach,
        arrived: (id: string) =>
          Ref.modify(handoffs, (all): [Option.Option<Deferred.Deferred<Handoff>>, ReadonlyMap<string, Deferred.Deferred<Handoff>>] => {
            const found = all.get(id)
            return found === undefined ? [Option.none(), all] : [Option.some(found), without(all, id)]
          }),
        views: SubscriptionRef.get(views),
        changes: Stream.merge(SubscriptionRef.changes(views), SubscriptionRef.changes(bumps)).pipe(Stream.as(undefined)),
        touch: SubscriptionRef.update(bumps, (n) => n + 1),
        live: (id: LinkId) =>
          Effect.flatMap(Ref.get(lives), (all) => {
            const live = all.get(id)
            return live === undefined ? offline(id) : Effect.succeed<Live>(live)
          }),
        connected: Effect.map(Ref.get(lives), (all): ReadonlyArray<Live> => [...all.values()]),
        dialInOver: (over: Rpc.ServerClient) =>
          Effect.gen(function* () {
            const live = (yield* Ref.get(attachedOn)).get(over)
            return live !== undefined && (yield* Ref.get(lives)).get(live.id) === live ? Option.some<Live>(live) : Option.none<Live>()
          }),
      }

      // A host that becomes a profile's assistant host is taken only the way it is linked: a dial-in standing in for one
      // the hub dials is dropped (the old `drop_misplaced`), and the dialled link takes its place when it connects.
      const watch = yield* events.watch(undefined)
      yield* watch.live.pipe(
        Stream.filter((event) => event.type === "profiles_changed"),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const assistants = yield* repo.assistantHosts
            for (const live of (yield* Ref.get(lives)).values()) {
              if (live.via !== "dial-in" || !assistants.has(live.id)) continue
              const row = yield* repo.get(live.id)
              if (row !== null && row.mode !== "inbound")
                yield* live.drop(`${identity.hostName} links assistant host ${row.name} itself, so a host that dials in under its id isn't taken for it`)
            }
          }),
        ),
        Effect.forkScoped,
      )

      // Every link the hub dials is dialled from the start.
      for (const link of yield* repo.list) if (link.mode !== "inbound") yield* start(link)

      return LinkConnections.of(connections)
    }),
  )
}

export type { Handoff }
