import { Context, Effect, Layer, Redacted } from "effect"
import { Mac } from "effect/crypto"
import { Auth, boardScopes, Forbidden, RequiredScope, Session, Unauthorized } from "@huntaway/contracts"
import type { SessionShape } from "@huntaway/contracts"
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

/**
 * The server's side of `Auth` (docs/plan/05-protocol.md, Sessions and scopes): the board token gives every scope but
 * `link`; the RPC's `RequiredScope` must be among the session's, and an RPC without one is refused.
 */
export const AuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const identity = yield* Identity
    const token = Redacted.value(identity.token)
    return Auth.of((effect, { headers, rpc }) => {
      const given = bearer(headers["authorization"])
      if (given === null || !sameSecret(given, token)) return Effect.fail(new Unauthorized())
      const scope = Context.get(rpc.annotations, RequiredScope)
      if (scope === null || !boardSession.scopes.has(scope)) return Effect.fail(new Forbidden({ scope: scope ?? "none" }))
      return Effect.provideService(effect, Session, boardSession)
    })
  }),
)
