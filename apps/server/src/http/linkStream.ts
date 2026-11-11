import { Deferred, Effect, Option, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { LinkConnections } from "../hosts/LinkConnections.ts"
import { accept } from "../hosts/pipe.ts"
import { Identity } from "../platform/Identity.ts"
import { bearer, sameSecret } from "../rpc/AuthLive.ts"

/**
 * `GET /api/link/stream/<id>` (docs/plan/05-protocol.md, Plain HTTP): a host that dialled in answering the hub's request
 * for one more socket. The hub token and a pending request's id are the auth, checked before the upgrade; the socket is
 * handed to whoever asked and kept until they are done with it.
 */
export const LinkStreamRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const connections = yield* LinkConnections
    const identity = yield* Identity
    const hubToken = Redacted.value(identity.hubToken)
    yield* router.add(
      "GET",
      "/api/link/stream/:id",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const given = bearer(request.headers["authorization"])
        if (given === null || !sameSecret(given, hubToken)) return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
        const params = yield* HttpRouter.params
        const waiting = yield* connections.arrived(params["id"] ?? "")
        if (Option.isNone(waiting)) return HttpServerResponse.jsonUnsafe({ error: "no such request for a socket" }, { status: 404 })
        const end = yield* accept
        const done = yield* Deferred.make<void>()
        yield* Deferred.succeed(waiting.value, { end, done })
        yield* Deferred.await(done)
        return HttpServerResponse.empty()
      }).pipe(Effect.catchTag("HttpServerError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    )
  }),
)
