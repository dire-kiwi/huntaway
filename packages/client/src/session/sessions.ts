import { Effect, type Layer, Schedule } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { HostId, Unavailable } from "@huntaway/contracts"
import { HostClient } from "./HostClient.ts"
import { connecting, HostSession, type SessionView } from "./HostSession.ts"
import { relayTransport, type Transport, websocketTransport } from "./transport.ts"

// Sessions (docs/plan/09-frontend.md): one RPC connection per host, each an atom runtime, so every atom of a host
// shares its connection. The page's own server is the hub; in M1 it is the only host, and `hostRuntime(itsId)` is the
// hub's own session (the same layer, built once by the registry's memo map).

/** The websocket URL of the page's own server's `/api/rpc`: the app sets it from `location`. */
export const serverUrlAtom: Atom.Writable<string> = Atom.make("").pipe(Atom.keepAlive)

/** The board token sent on every request. The app keeps it in storage (`ia.token`) and sets it here. */
export const tokenAtom: Atom.Writable<string | null> = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/**
 * While true, no host's board is subscribed to: the app holds it while it settles which token to use (a board that
 * hands out its token, asked first when the page has none), so the token screen does not flash up meanwhile.
 */
export const tokenPendingAtom: Atom.Writable<boolean> = Atom.make(false).pipe(Atom.keepAlive)

/** Replaces the websocket with another transport (an in-memory host in tests). `null` is the websocket. */
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

/** One runtime per host. Atoms for a host are built from its runtime, so they share its connection. */
export const hostRuntime: (host: HostId) => Atom.AtomRuntime<HostClient | HostSession, Unavailable> = Atom.family((host: HostId) =>
  Atom.runtime((get) => {
    // Read once: a host's runtime is asked for only once its id is known, and the page's own host keeps its id, so
    // the health check settling must not rebuild every host's runtime (and resubscribe its board).
    if (host === get.once(localHostIdAtom)) return get(ownLayerAtom)
    const transport = get(transportAtom)
    return transport ? transport(host) : relayTransport(host)
  }),
)

const sessionRef = Atom.family((host: HostId) => hostRuntime(host).subscriptionRef(HostSession.use((s) => Effect.succeed(s.view))))

/** A host's session: its state and what it says of itself. `connecting` until its runtime is built. */
export const hostSessionAtom: (host: HostId) => Atom.Atom<SessionView> = Atom.family((host: HostId) =>
  Atom.make((get) => AsyncResult.getOrElse(get(sessionRef(host)), () => connecting)).pipe(Atom.keepAlive),
)
