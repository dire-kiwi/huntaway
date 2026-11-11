import { Clock, Duration, Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Relay } from "../hosts/Relay.ts"
import { accept, pipe } from "../hosts/pipe.ts"

/**
 * `GET /api/relay/<ticket>` (docs/plan/08-hosts.md, Relay): the ticket alone is the auth. A bad or used ticket is a
 * JSON 404 and a host that has gone offline a 503, both before the upgrade; then the client's socket and the host's
 * are piped until either closes, or the relayed session ends.
 */
export const RelayRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* Relay
    yield* router.add(
      "GET",
      "/api/relay/:ticket",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const taken = yield* Effect.result(relay.take(params["ticket"] ?? ""))
        if (taken._tag === "Failure") return HttpServerResponse.jsonUnsafe({ error: `host ${taken.failure.host_name} is offline` }, { status: 503 })
        const opened = taken.success
        if (Option.isNone(opened)) return HttpServerResponse.jsonUnsafe({ error: "no such relay ticket, or it was used or has expired" }, { status: 404 })
        const client = yield* accept
        const host = yield* opened.value.end
        const left = Duration.millis(Math.max(0, opened.value.expires - (yield* Clock.currentTimeMillis)))
        yield* pipe(client, host).pipe(Effect.timeoutOption(left))
        return HttpServerResponse.empty()
      }).pipe(Effect.catchTag("HttpServerError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    )
  }),
)
