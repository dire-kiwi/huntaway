import { Clock, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { Mac } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { AssertedSession, boardScopes, LinkId } from "@huntaway/contracts"
import type { Scope, SessionShape } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"

// The session a hub asserts for a socket it relays (docs/plan/08-hosts.md, Relay): `<payload>.<mac>` in the upgrade
// request's `x-huntaway-session`, the hub's id in `x-huntaway-link`. The mac is HMAC-SHA256 under the board token of
// the host that serves the socket: a hub that dials a host holds that token (the link's), and a host that dialled a hub
// seals the hub's claim itself before it pipes the hub's socket to its own `/api/rpc`. So a host checks every sealed
// session with its own token, and a host that dials a hub never takes a session sealed with the hub token, which every
// other host that dials that hub also holds.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What a sealed session looks like: base64url payload, a dot, a 32-byte mac in base64url. Nothing else. */
const SEALED = /^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/
/** A link's id as the header gives it: a host id. A value joined with a second header of the name (`a, b`) fails. */
const LINK = /^[A-Za-z0-9_-]{1,200}$/

const AssertedJson = Schema.fromJsonString(AssertedSession)
const decodeAsserted = Schema.decodeUnknownOption(AssertedJson)
const encodeAsserted = Schema.encodeEffect(AssertedJson)

/** An HMAC-SHA256 key from a token. */
const keyOf = (token: Redacted.Redacted) => Mac.key(Mac.hmacSha256, encoder.encode(Redacted.value(token))).pipe(Effect.orDie)

/** A session of kind `link` (a hub's own connection) may have `link` too; a relayed client never. A device: read and operate. */
const allowedScopes = (kind: AssertedSession["kind"]): ReadonlySet<Scope> =>
  kind === "link" ? new Set<Scope>([...boardScopes, "link"]) : kind === "device" ? new Set<Scope>(["read", "operate"]) : boardScopes

/** The session a host gives a sealed assertion it has checked: no scope beyond what its kind may have. */
export const sessionOf = (asserted: AssertedSession, via: LinkId): SessionShape => {
  const allowed = allowedScopes(asserted.kind)
  return {
    kind: asserted.kind,
    scopes: new Set(asserted.scopes.filter((scope) => allowed.has(scope))),
    device_id: asserted.kind === "device" ? asserted.device_id : null,
    via_link: via,
  }
}

export class SessionSeal extends Context.Service<
  SessionSeal,
  {
    /** `<payload>.<mac>` for `session`, under `key` (the board token of the host that will serve the socket). */
    readonly seal: (key: Redacted.Redacted, session: AssertedSession) => Effect.Effect<string>
    /**
     * The session a socket's upgrade headers assert, if `link` is a well-formed id and `sealed` is well formed, sealed
     * under this host's board token and not expired. Anything else is none: the caller refuses the request.
     */
    readonly open: (link: string, sealed: string) => Effect.Effect<Option.Option<SessionShape>>
  }
>()("huntaway-server/hosts/SessionSeal") {
  static readonly layer = Layer.effect(
    SessionSeal,
    Effect.gen(function* () {
      const mac = yield* Mac.Mac
      const identity = yield* Identity
      const own = yield* keyOf(identity.token)
      return SessionSeal.of({
        seal: Effect.fn("SessionSeal.seal")(function* (token, session) {
          const payload = Base64Url.encode(yield* encodeAsserted(session).pipe(Effect.orDie))
          const tag = yield* mac.sign(yield* keyOf(token), encoder.encode(payload)).pipe(Effect.orDie)
          return `${payload}.${Base64Url.encode(tag)}`
        }),
        open: Effect.fn("SessionSeal.open")(function* (link, sealed) {
          const parts = SEALED.exec(sealed)
          if (!LINK.test(link) || parts === null) return Option.none()
          const [, payload = "", tagText = ""] = parts
          const tag = Base64Url.decode(tagText)
          if (Result.isFailure(tag)) return Option.none()
          const valid = yield* mac.verify(own, tag.success, encoder.encode(payload)).pipe(Effect.orElseSucceed(() => false))
          if (!valid) return Option.none()
          const bytes = Base64Url.decode(payload)
          if (Result.isFailure(bytes)) return Option.none()
          const asserted = decodeAsserted(decoder.decode(bytes.success))
          if (Option.isNone(asserted)) return Option.none()
          const now = yield* Clock.currentTimeMillis
          if (asserted.value.exp <= now) return Option.none()
          return Option.some(sessionOf(asserted.value, LinkId.make(link)))
        }),
      })
    }),
  )
}
