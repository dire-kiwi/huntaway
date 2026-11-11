import { ByteSize, Effect, FileSystem, Layer, Path } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { About } from "../settings/About.ts"

/** `GET /api/health`: `{ ok, host_id, version, protocol, capabilities, commit }`, with no token. */
export const HealthRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const about = yield* About
    yield* router.add(
      "GET",
      "/api/health",
      Effect.map(about.health, (health) => HttpServerResponse.jsonUnsafe(health)),
    )
  }),
)

/** Anything else under `/api` is not a route: a JSON 404, never the UI. */
export const ApiNotFound = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add("*", "/api/*", (request) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: `no such API route: ${request.method} ${request.url}` }, { status: 404 })),
    )
  }),
)

/** The built UI of this checkout, beside the server: `apps/web/dist`. */
const checkoutUi = new URL("../../../web/dist/", import.meta.url)

/**
 * The built UI for everything not under `/api`, with the single-page fallback (docs/plan/inventory/07-server-root-api.md,
 * 7.4). `/assets/*` is immutable; everything else is `no-cache`. Files never leave the UI folder. With no UI folder,
 * a 404.
 */
export const StaticUi = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = config.uiDir ?? (yield* path.fromFileUrl(checkoutUi).pipe(Effect.orDie))
    const hasUi = yield* fs.exists(path.join(root, "index.html")).pipe(Effect.orElseSucceed(() => false))
    if (!hasUi) {
      yield* Effect.logWarning(`no built UI in ${root}: run pnpm build, or give --ui-dir`)
      return HttpRouter.use(
        Effect.fn(function* (router) {
          yield* router.add("GET", "/*", HttpServerResponse.text("no UI here: run pnpm build", { status: 404 }))
        }),
      )
    }
    return HttpRouter.use(
      Effect.fn(function* (router) {
        const serve = yield* HttpStaticServer.make({ root, spa: true })
        yield* router.add("GET", "/*", (request) =>
          Effect.gen(function* () {
            const response = yield* serve
            const immutable = request.url.startsWith("/assets/") && !request.url.endsWith(".html")
            return HttpServerResponse.setHeader(response, "cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
          }).pipe(Effect.catch((e) => Effect.succeed(HttpServerResponse.text(e.message, { status: 404 })))),
        )
      }),
    )
  }),
)

/**
 * The largest request body read: an attachment's 10 MiB as base64 in one RPC, with room (docs/plan/inventory/
 * 07-server-root-api.md, 7.3). A larger one is answered 413 without being kept in memory; the RPC's own framing
 * refuses messages over 16 MiB anyway.
 */
export const MAX_BODY = ByteSize.mebibytes(16)

export const BodyLimit = HttpRouter.middleware((app) => Effect.provideService(app, HttpIncomingMessage.MaxBodySize, MAX_BODY), { global: true })
