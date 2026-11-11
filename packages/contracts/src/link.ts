import { Schema } from "effect"
import { UpdatesFrom } from "./host.ts"
import { DeviceId, HostId } from "./ids.ts"
import { Scope } from "./session.ts"

// What hosts say to each other (docs/plan/08-hosts.md). A relayed socket's session travels in the headers of its
// upgrade request, which the RPC server puts in front of every request's own headers on that socket.

/** The hub's host id, on the upgrade request of a socket it opened (or had opened) for someone. */
export const LINK_HEADER = "x-huntaway-link"

/** `<payload>.<mac>`: the session the hub asserts, `base64url(JSON)`, and `base64url(HMAC-SHA256(key, payload))`. */
export const SESSION_HEADER = "x-huntaway-session"

/**
 * The session a hub asserts for a socket it relays: the client's kind and scopes, and when the assertion ends (ms since
 * the epoch). The host gives it no more than a board user's scopes, and `link` only to a session of kind `link` (a hub's
 * own connection).
 */
export const AssertedSession = Schema.Struct({
  kind: Schema.Literals(["board", "device", "link"]),
  scopes: Schema.Array(Scope),
  device_id: Schema.NullOr(DeviceId),
  exp: Schema.Int,
})
export interface AssertedSession extends Schema.Schema.Type<typeof AssertedSession> {}

/** What each end of a link says of itself (`link.hello`, both directions): part of the stable core. */
export const LinkHello = Schema.Struct({
  host_id: HostId,
  name: Schema.String,
  /** The RPC protocol it speaks (`PROTOCOL`); a different one leaves the link `needs_update`. */
  protocol: Schema.Int,
  version: Schema.String,
  capabilities: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  /** It can run agents. */
  agents: Schema.Boolean,
  updates_from: Schema.NullOr(UpdatesFrom),
})
export interface LinkHello extends Schema.Schema.Type<typeof LinkHello> {}

/** A link's live state, as the hub sees it. */
export const LinkStatus = Schema.Literals(["connecting", "connected", "offline", "needs_update", "refused"])
export type LinkStatus = typeof LinkStatus.Type

/** The other end refused the link: why, to show beside it. */
export class LinkRefused extends Schema.TaggedError<LinkRefused, { readonly brand: unique symbol }>()("LinkRefused", { reason: Schema.String }) {}

/**
 * The hub asks a host that dialled in for one more socket (`link.attach`): the host dials `/api/link/stream/<id>` and
 * pipes it to its own `path`, with `session` sealed under its own token on the way.
 */
export const OpenStream = Schema.Struct({ id: Schema.String, path: Schema.String, session: AssertedSession })
export interface OpenStream extends Schema.Schema.Type<typeof OpenStream> {}
