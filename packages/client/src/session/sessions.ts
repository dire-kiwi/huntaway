import { Cause, Context, Effect, Exit, type Layer, Option, Predicate, Queue, Schedule, Stream } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { type Host, type HostId, PROTOCOL, Unavailable } from "@huntaway/contracts"
import { HostClient } from "./HostClient.ts"
import { connecting, HostSession, type SessionView } from "./HostSession.ts"
import { relayTransport } from "./relay.ts"
import { type Transport, websocketTransport } from "./transport.ts"

// Sessions (docs/plan/09-frontend.md): one RPC connection per host, each an atom runtime, so every atom of a host
// shares its connection. The page's own server is the hub: `hostRuntime(itsId)` is the hub's own session (the same
// layer, built once by the registry's memo map), and every host it links is reached through its relay (relay.ts).

/** The websocket URL of the page's own server's `/api/rpc`: the app sets it from `location`. */
export const serverUrlAtom: Atom.Writable<string> = Atom.make("").pipe(Atom.keepAlive)

/** The board token sent on every request. The app keeps it in storage (`ia.token`) and sets it here. */
export const tokenAtom: Atom.Writable<string | null> = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/**
 * While true, no host's board is subscribed to: the app holds it while it settles which token to use (a board that
 * hands out its token, asked first when the page has none), so the token screen does not flash up meanwhile.
 */
export const tokenPendingAtom: Atom.Writable<boolean> = Atom.make(false).pipe(Atom.keepAlive)

/** Replaces the websocket and the relay with another transport (in-memory hosts in tests). `null` is the websocket. */
export const transportAtom: Atom.Writable<Transport | null> = Atom.make<Transport | null>(null).pipe(Atom.keepAlive)

/** The page's own server's session layer: one object while the URL, token and transport stay, so it is built once. */
const ownLayerAtom: Atom.Atom<Layer.Layer<HostClient | HostSession, Unavailable>> = Atom.make((get) => {
  const transport = get(transportAtom)
  return transport ? transport(null) : websocketTransport(get(serverUrlAtom), get(tokenAtom))
}).pipe(Atom.keepAlive)

/** The board the page was opened on. */
export const hubRuntime: Atom.AtomRuntime<HostClient | HostSession, Unavailable> = Atom.runtime((get) => get(ownLayerAtom))

/** What the page's own server says of itself without a token (`public.health`), asked again until it answers. */
export const hubHealthAtom = hubRuntime
  .atom(
    Effect.gen(function* () {
      const client = yield* HostClient
      return yield* client("public.health", undefined).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }))
    }),
  )
  .pipe(Atom.keepAlive)

/** The page's own host's id, once its server has said. */
export const localHostIdAtom: Atom.Atom<HostId | null> = Atom.make((get) => {
  const health = get(hubHealthAtom)
  return AsyncResult.isSuccess(health) ? health.value.host_id : null
}).pipe(Atom.keepAlive)

/**
 * The hub's directory as a stream: `hub.hosts.watch` (this host and every linked one, with its live state, again on
 * every change), subscribed again when the hub's connection comes back. A token turned down ends it (the token screen
 * shows; a new token rebuilds the runtime).
 */
const watchHosts: Stream.Stream<ReadonlyArray<Host>, never, HostClient | HostSession> = Stream.callback<ReadonlyArray<Host>, never, HostClient | HostSession>(
  (queue) =>
    Effect.gen(function* () {
      const client = yield* HostClient
      const session = yield* HostSession
      // Subscribe after the atom that runs this has been built (see watchBoard).
      yield* Effect.yieldNow
      while (true) {
        let heard = false
        const exit = yield* client("hub.hosts.watch", undefined).pipe(
          Stream.runForEach((hosts) => {
            heard = true
            return Queue.offer(queue, hosts)
          }),
          Effect.exit,
        )
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
          if (Predicate.isTagged(Option.getOrUndefined(Cause.findErrorOption(exit.cause)), "Unauthorized")) return yield* Effect.void
        }
        yield* session.connected.await
        if (!heard) yield* Effect.sleep("1 second")
      }
    }),
  { bufferSize: 1, strategy: "sliding" },
)

/** The hub's hosts with their live state (`hub.hosts.watch`), kept for the whole page. */
export const hubHostsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<Host>, Unavailable | Cause.NoSuchElementError>> = hubRuntime
  .atom(watchHosts)
  .pipe(Atom.keepAlive)

const noHosts: ReadonlyArray<Host> = []

/** The hub's hosts, the page's own included; none until the hub has said. */
export const hubHostListAtom: Atom.Atom<ReadonlyArray<Host>> = Atom.make((get) => AsyncResult.getOrElse(get(hubHostsAtom), () => noHosts)).pipe(Atom.keepAlive)

/**
 * A linked host that speaks another protocol than this client (docs/plan/05-protocol.md, Versions): it shows "needs an
 * update" and nothing else, and is not subscribed to.
 */
export const needsUpdate = (h: Pick<Host, "local" | "protocol" | "status">): boolean =>
  !h.local && (h.status === "needs_update" || (h.protocol !== null && h.protocol !== PROTOCOL))

/**
 * A ticket for a socket to `host` through the hub: asked for once the hub says the host is connected (so a host that is
 * away, or forgotten, costs no requests), on the hub's own session.
 */
const openRelay = (host: HostId): Effect.Effect<string, Unavailable, AtomRegistry.AtomRegistry> =>
  Effect.gen(function* () {
    yield* Atom.toStream(hubHostListAtom).pipe(
      Stream.filter((hosts) => hosts.some((h) => h.id === host && h.connected)),
      Stream.runHead,
    )
    const hub = yield* Atom.getResult(hubRuntime, { suspendOnWaiting: true })
    const { ticket } = yield* Context.get(hub, HostClient)("hub.hosts.openRelay", { host_id: host }).pipe(
      Effect.mapError((e) => new Unavailable({ what: `host ${host}`, reason: `the hub gave no relay ticket (${e._tag})` })),
    )
    return ticket
  })

/** One runtime per host. Atoms for a host are built from its runtime, so they share its connection. */
export const hostRuntime: (host: HostId) => Atom.AtomRuntime<HostClient | HostSession, Unavailable> = Atom.family((host: HostId) =>
  Atom.runtime((get): Layer.Layer<HostClient | HostSession, Unavailable, AtomRegistry.AtomRegistry> => {
    // Read once: a host's runtime is asked for only once its id is known, and the page's own host keeps its id, so
    // the health check settling must not rebuild every host's runtime (and resubscribe its board).
    if (host === get.once(localHostIdAtom)) return get(ownLayerAtom)
    const transport = get(transportAtom)
    return transport ? transport(host) : relayTransport(get(serverUrlAtom), openRelay(host))
  }),
)

const sessionRef = Atom.family((host: HostId) => hostRuntime(host).subscriptionRef(HostSession.use((s) => Effect.succeed(s.view))))

/** The hub's entry for a linked host that needs an update, if it is one. */
export const needsUpdateEntry: (host: HostId) => Atom.Atom<Host | undefined> = Atom.family((host: HostId) =>
  Atom.make((get) => get(hubHostListAtom).find((h) => h.id === host && needsUpdate(h))),
)

/**
 * A host's session: its state and what it says of itself. `connecting` until its runtime is built; `needs_update`,
 * without a connection, for a linked host the hub says speaks another protocol.
 */
export const hostSessionAtom: (host: HostId) => Atom.Atom<SessionView> = Atom.family((host: HostId) =>
  Atom.make((get): SessionView => {
    const outdated = get(needsUpdateEntry(host))
    if (outdated) return { state: { _tag: "needs_update", protocol: outdated.protocol ?? 0 }, info: null }
    return AsyncResult.getOrElse(get(sessionRef(host)), () => connecting)
  }).pipe(Atom.keepAlive),
)
