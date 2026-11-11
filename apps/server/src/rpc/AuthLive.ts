import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Mac } from "effect/crypto"
import { Auth, boardScopes, Forbidden, LINK_HEADER, RequiredScope, Session, SESSION_HEADER, Unauthorized } from "@huntaway/contracts"
import type { SessionShape } from "@huntaway/contracts"
import { SessionSeal } from "../hosts/SessionSeal.ts"
import { Identity } from "../platform/Identity.ts"

const encoder = new TextEncoder()

/** Two secrets compared in constant time. */
export const sameSecret = (a: string, b: string): boolean => {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  return x.length === y.length && Mac.timingSafeEqual(x, y)
}

/** The token a request carries: `authorization: Bearer <token>`. */
export const bearer = (authorization: string | undefined): string | null => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "")
  return match?.[1] ?? null
}

const boardSession: SessionShape = { kind: "board", scopes: boardScopes, device_id: null, via_link: null }

/** A host that dialled in, with the hub token every such host shares: `link` and nothing else. */
const hubTokenSession: SessionShape = { kind: "link", scopes: new Set(["link"]), device_id: null, via_link: null }

/**
 * The server's side of `Auth` (docs/plan/05-protocol.md, Sessions and scopes). A socket a hub relays carries its
 * session sealed in the headers of its upgrade request (`x-huntaway-link`, `x-huntaway-session`), which the RPC server
 * puts before each request's own: such a request's session comes from the seal alone, and its bearer token is ignored.
 * A request header of the same name joins the upgrade's (`a, b`) and fails the seal, so a relayed client can spoil its
 * own session but never forge one. Otherwise the board token gives every scope but `link`, and the hub token (a host
 * that dials in) `link` alone. The RPC's `RequiredScope`
 * must be among the session's, and an RPC without one is refused.
 */
export const AuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const identity = yield* Identity
    const seal = yield* SessionSeal
    const token = Redacted.value(identity.token)
    const hubToken = Redacted.value(identity.hubToken)
    return Auth.of((effect, { headers, rpc }) => {
      const scope = Context.get(rpc.annotations, RequiredScope)
      const withSession = (session: SessionShape) =>
        scope === null || !session.scopes.has(scope) ? Effect.fail(new Forbidden({ scope: scope ?? "none" })) : Effect.provideService(effect, Session, session)
      const link = headers[LINK_HEADER]
      const sealed = headers[SESSION_HEADER]
      if (link !== undefined || sealed !== undefined)
        return Effect.flatMap(seal.open(link ?? "", sealed ?? ""), Option.match({ onNone: () => Effect.fail(new Unauthorized()), onSome: withSession }))
      const given = bearer(headers["authorization"])
      if (given !== null && sameSecret(given, token)) return withSession(boardSession)
      if (given !== null && sameSecret(given, hubToken)) return withSession(hubTokenSession)
      return Effect.fail(new Unauthorized())
    })
  }),
)
