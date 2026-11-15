import { Effect, Redacted } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Identity } from "../platform/Identity.ts"
import { Plugins } from "../plugins/Plugins.ts"
import { bearer, sameSecret } from "../rpc/AuthLive.ts"

// HE-34: the plugins' HTTP routes, `/plugins/<id><path>` (docs/plan/15-plugins.md, Routes). A route is the board's
// unless it says it's public: it then needs the board token as its bearer token, as `/api/rpc` over HTTP does.

export const PluginRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const plugins = yield* Plugins
    const identity = yield* Identity
    const token = Redacted.value(identity.token)
    for (const { plugin, route } of plugins.routes) {
      yield* router.add(route.method, `/plugins/${plugin}${route.path}`, (request) => {
        if (route.auth !== "public") {
          const given = bearer(request.headers["authorization"])
          if (given === null || !sameSecret(given, token)) return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 }))
        }
        return route.handle(request).pipe(Effect.annotateLogs({ module: "plugin", plugin }))
      })
    }
  }),
)
