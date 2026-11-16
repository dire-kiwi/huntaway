import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import type { Rpc } from "effect/rpc"
import { boardScopes, Conflict, HostOffline, Invalid, LinkId, LinkRefused, NotFound } from "@huntaway/contracts"
import type { AssertedSession, DeviceId, HostId, Scope as SessionScope, SessionShape } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { LinkConnections, STREAM_PATH } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"
import { Mesh } from "./Mesh.ts"
import type { Pipeable } from "./pipe.ts"

// The relay (docs/plan/08-hosts.md, Relay): a client asks its hub for a ticket to another host, then opens
// `/api/relay/<ticket>`; the hub asks that host's connection for a socket and pipes the two until either closes, never
// decoding what passes. A ticket is single-use, good for a minute and bound to the session that asked: the relayed
// socket carries that session's scopes (never `link`), sealed for the host, for as long as `RELAYED` at most.
//
// The mesh (HE-46): a host the hub doesn't link itself is reached through the neighbour the mesh names, which is asked
// for a ticket of its own (`hub.hosts.openRelay` with `as`, the client's session) and whose `/api/relay/<ticket>` this
// hub's socket to it opens. A host that dialled in asks for a ticket to this hub itself (`link.ticket`), while this hub's
// link to it has its Mesh switch on.

/** How long a ticket waits to be used. */
export const TICKET_LIFE = Duration.minutes(1)
/** How long a relayed socket's session lasts; the client dials again with a new ticket after. */
export const RELAYED = Duration.hours(12)
/** How long a session this hub gives a host that dialled in may last (its own on a host it dials does too). */
const LINKED = Duration.days(7)

/** What a client may reach through the relay: a host's RPC, or a terminal by its ticket. */
const PATH = /^\/api\/(rpc|terminal\/[A-Za-z0-9_-]{1,200})$/

/** Where a ticket goes: a host this hub links, one the mesh reaches through a neighbour (`hop`), or this hub itself. */
type Target =
  | { readonly _tag: "Link"; readonly host: LinkId }
  | { readonly _tag: "Mesh"; readonly host: HostId; readonly hop: LinkId }
  | { readonly _tag: "Self"; readonly via: LinkId }

interface Ticket {
  readonly target: Target
  readonly path: string
  readonly session: AssertedSession
  readonly expires: number
}

/** A relay a client may now open: the socket to the host, and when its session ends. */
export interface Opened {
  /** For the scope of the relay. */
  readonly end: Effect.Effect<Pipeable, HostOffline, Scope.Scope>
  readonly expires: number
}

/** The client a neighbour relays for: its session as that neighbour has it. */
export interface RelayedFor {
  readonly kind: "board" | "device"
  readonly scopes: ReadonlyArray<SessionScope>
  readonly device_id: DeviceId | null
}

export class Relay extends Context.Service<
  Relay,
  {
    /** A ticket to `host`'s `path` for `session` (or, on a neighbour's own connection, for the client it relays: `as`). */
    readonly open: (session: SessionShape, host: HostId, path: string, as?: RelayedFor) => Effect.Effect<string, NotFound | Invalid | HostOffline | Conflict>
    /** `link.ticket`: a ticket to this host's own `path`, for the host that dialled in on RPC connection `over`. */
    readonly forDialIn: (over: Rpc.ServerClient, path: string, session: AssertedSession) => Effect.Effect<string, LinkRefused>
    /** Uses up `ticket`: the socket to open, if the ticket is good and its host still connected. */
    readonly take: (ticket: string) => Effect.Effect<Option.Option<Opened>, HostOffline>
  }
>()("huntaway-server/hosts/Relay") {
  static readonly layer = Layer.effect(
    Relay,
    Effect.gen(function* () {
      const connections = yield* LinkConnections
      const repo = yield* LinkRepo
      const mesh = yield* Mesh
      const identity = yield* Identity
      const random = yield* SecureRandom.SecureRandom
      const tickets = yield* Ref.make<ReadonlyMap<string, Ticket>>(new Map())

      const issue = (target: Target, path: string, session: AssertedSession) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const ticket = Hex.encode(yield* random.randomBytes(32))
          yield* Ref.update(tickets, (all) => {
            // Expired tickets go as new ones come.
            const next = new Map([...all].filter(([, t]) => t.expires > now))
            return next.set(ticket, { target, path, session, expires: now + Duration.toMillis(TICKET_LIFE) })
          })
          return ticket
        })

      const open = Effect.fn("Relay.open")(function* (session: SessionShape, host: HostId, path: string, as?: RelayedFor) {
        if (host === identity.hostId) return yield* new Invalid({ field: "host_id", reason: "this host is reached directly, not through the relay" })
        if (!PATH.test(path)) return yield* new Invalid({ field: "path", reason: "only a host's /api/rpc or a terminal can be relayed" })
        // A neighbour's own connection relays only for a client of its own, with no more than its own scopes.
        if (session.kind === "link" && as === undefined)
          return yield* new Conflict({ reason: "in_use", detail: "a host's own connection is relayed further only for a client of its own" })
        const now = yield* Clock.currentTimeMillis
        // `as` only ever narrows: whoever asks, the client's session gets no more than the asker's own scopes.
        const who = as ?? { kind: session.kind, scopes: [...session.scopes], device_id: session.device_id }
        const asserted: AssertedSession = {
          kind: who.kind === "link" ? "board" : who.kind,
          scopes: who.scopes.filter((scope) => scope !== "link" && session.scopes.has(scope)),
          device_id: who.kind === "device" ? who.device_id : null,
          exp: now + Duration.toMillis(RELAYED),
        }
        const id = LinkId.make(host)
        if ((yield* repo.get(id)) !== null) {
          const live = yield* connections.live(id)
          return yield* issue({ _tag: "Link", host: live.id }, path, asserted)
        }
        const hop = yield* mesh.through(host)
        if (hop === null) return yield* new NotFound({ what: "host", id: host })
        yield* connections.live(hop)
        return yield* issue({ _tag: "Mesh", host, hop }, path, asserted)
      })

      const forDialIn = Effect.fn("Relay.forDialIn")(function* (over: Rpc.ServerClient, path: string, session: AssertedSession) {
        const live = yield* connections.dialInOver(over)
        if (Option.isNone(live) || live.value.via !== "dial-in")
          return yield* new LinkRefused({ reason: `${identity.hostName} gives tickets only to a host that dialled in, on the connection it attached on` })
        const row = yield* repo.get(live.value.id)
        if (row === null || row.mode !== "inbound" || !row.mesh)
          return yield* new LinkRefused({ reason: `${identity.hostName} doesn't let this host reach it back` })
        if (!STREAM_PATH.test(path)) return yield* new LinkRefused({ reason: `${path} isn't something a host is asked for` })
        const now = yield* Clock.currentTimeMillis
        // What the socket may do is this hub's to say, not the asker's: no more than a board user's scopes, never `link`
        // (a host that dialled in calls no board tools down, nor attaches, through it), and a device's no more than a
        // device's. The host's agents' calls go up on its control connection, under the link's `uplink` switch.
        const kind = session.kind === "device" ? "device" : "board"
        return yield* issue({ _tag: "Self", via: live.value.id }, path, {
          kind,
          scopes: session.scopes.filter((scope) => boardScopes.has(scope) && (kind === "board" || scope === "read" || scope === "operate")),
          device_id: kind === "device" ? session.device_id : null,
          exp: Math.min(session.exp, now + Duration.toMillis(LINKED)),
        })
      })

      /** The socket to a mesh host: a ticket of the neighbour's, then its `/api/relay/<ticket>` on this hub's way to it. */
      const throughHop = (t: Ticket, host: HostId, hop: LinkId) =>
        Effect.gen(function* () {
          const live = yield* connections.live(hop)
          const as: RelayedFor = { kind: t.session.kind === "device" ? "device" : "board", scopes: t.session.scopes, device_id: t.session.device_id }
          const { ticket } = yield* live
            .client("hub.hosts.openRelay", { host_id: host, path: t.path, as })
            .pipe(Effect.mapError(() => new HostOffline({ host_id: host, host_name: host })))
          return yield* live.open(`/api/relay/${ticket}`, t.session)
        })

      const take = Effect.fn("Relay.take")(function* (ticket: string) {
        const now = yield* Clock.currentTimeMillis
        const found = yield* Ref.modify(tickets, (all): [Ticket | undefined, ReadonlyMap<string, Ticket>] => {
          const t = all.get(ticket)
          if (t === undefined) return [undefined, all]
          const next = new Map(all)
          next.delete(ticket)
          return [t, next]
        })
        if (found === undefined || found.expires <= now) return Option.none<Opened>()
        const target = found.target
        if (target._tag === "Link") {
          const live = yield* connections.live(target.host)
          return Option.some<Opened>({ end: live.open(found.path, found.session), expires: found.session.exp })
        }
        if (target._tag === "Mesh") {
          yield* connections.live(target.hop)
          return Option.some<Opened>({ end: throughHop(found, target.host, target.hop), expires: found.session.exp })
        }
        return Option.some<Opened>({ end: connections.self(found.path, found.session, target.via), expires: found.session.exp })
      })

      return Relay.of({ open, forDialIn, take })
    }),
  )
}
