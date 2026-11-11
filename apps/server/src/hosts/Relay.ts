import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import { Conflict, Invalid, LinkId, NotFound } from "@huntaway/contracts"
import type { AssertedSession, HostId, HostOffline, SessionShape } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { LinkConnections } from "./LinkConnections.ts"
import type { Live } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { Pipeable } from "./pipe.ts"

// The relay (docs/plan/08-hosts.md, Relay): a client asks its hub for a ticket to another host, then opens
// `/api/relay/<ticket>`; the hub asks that host's connection for a socket and pipes the two until either closes, never
// decoding what passes. A ticket is single-use, good for a minute and bound to the session that asked: the relayed
// socket carries that session's scopes (never `link`), sealed for the host, for as long as `RELAYED` at most.

/** How long a ticket waits to be used. */
export const TICKET_LIFE = Duration.minutes(1)
/** How long a relayed socket's session lasts; the client dials again with a new ticket after. */
export const RELAYED = Duration.hours(12)

/** What may be reached through the relay: a host's RPC, or a terminal by its ticket. */
const PATH = /^\/api\/(rpc|terminal\/[A-Za-z0-9_-]{1,200})$/

interface Ticket {
  readonly host: LinkId
  readonly path: string
  readonly session: AssertedSession
  readonly expires: number
}

/** A relay a client may now open: the socket to the host, and when its session ends. */
export interface Opened {
  readonly host: LinkId
  readonly end: Effect.Effect<Pipeable>
  readonly expires: number
}

export class Relay extends Context.Service<
  Relay,
  {
    /** A ticket to `host`'s `path` for `session`. */
    readonly open: (session: SessionShape, host: HostId, path: string) => Effect.Effect<string, NotFound | Invalid | HostOffline | Conflict>
    /** Uses up `ticket`: the socket to open, if the ticket is good and its host still connected. */
    readonly take: (ticket: string) => Effect.Effect<Option.Option<Opened>, HostOffline>
  }
>()("huntaway-server/hosts/Relay") {
  static readonly layer = Layer.effect(
    Relay,
    Effect.gen(function* () {
      const connections = yield* LinkConnections
      const repo = yield* LinkRepo
      const identity = yield* Identity
      const random = yield* SecureRandom.SecureRandom
      const tickets = yield* Ref.make<ReadonlyMap<string, Ticket>>(new Map())

      const open = Effect.fn("Relay.open")(function* (session: SessionShape, host: HostId, path: string) {
        if (host === identity.hostId) return yield* new Invalid({ field: "host_id", reason: "this host is reached directly, not through the relay" })
        if (!PATH.test(path)) return yield* new Invalid({ field: "path", reason: "only a host's /api/rpc or a terminal can be relayed" })
        if (session.kind === "link") return yield* new Conflict({ reason: "in_use", detail: "a host's own connection is not relayed further" })
        const id = LinkId.make(host)
        if ((yield* repo.get(id)) === null) return yield* new NotFound({ what: "host", id: host })
        const live: Live = yield* connections.live(id)
        const now = yield* Clock.currentTimeMillis
        const ticket = Hex.encode(yield* random.randomBytes(32))
        const asserted: AssertedSession = {
          kind: session.kind,
          scopes: [...session.scopes].filter((scope) => scope !== "link"),
          device_id: session.device_id,
          exp: now + Duration.toMillis(RELAYED),
        }
        yield* Ref.update(tickets, (all) => {
          // Expired tickets go as new ones come.
          const next = new Map([...all].filter(([, t]) => t.expires > now))
          return next.set(ticket, { host: live.id, path, session: asserted, expires: now + Duration.toMillis(TICKET_LIFE) })
        })
        return ticket
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
        const live = yield* connections.live(found.host)
        return Option.some<Opened>({ host: found.host, end: live.open(found.path, found.session), expires: found.session.exp })
      })

      return Relay.of({ open, take })
    }),
  )
}
