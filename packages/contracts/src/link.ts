import { Schema } from "effect"
import { DeviceId } from "./ids.ts"
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
