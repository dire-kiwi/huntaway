import { ByteSize, Effect, FileSystem, Layer, Path } from "effect"
import { HttpIncomingMessage, HttpRouter, type HttpServerError, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
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
            const response = yield* servePrecompressed(serve, request)
            const immutable = request.url.startsWith("/assets/") && !request.url.endsWith(".html")
            return HttpServerResponse.setHeader(response, "cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
          }).pipe(Effect.catch((e) => Effect.succeed(HttpServerResponse.text(e.message, { status: 404 })))),
        )
      }),
    )
  }),
)

/**
 * The types of the files the build compresses (apps/web/vite.config.ts, `precompress`), as `HttpStaticServer` gives
 * them: a compressed variant's own name (`.br`, `.gz`) says nothing of what it holds.
 */
const compressibleTypes: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  ttf: "font/ttf",
  wasm: "application/wasm",
}

/** The variants the build writes beside a file, in the order the server prefers them. */
const encodings = [
  { name: "br", suffix: ".br" },
  { name: "gzip", suffix: ".gz" },
] as const

/** Whether `Accept-Encoding` takes `name`: listed, or covered by `*`, with a q-value above 0 (RFC 9110, 12.5.3). */
export const acceptsEncoding = (header: string | undefined, name: string): boolean => {
  if (header === undefined) return false
  let wildcard: boolean | undefined
  for (const part of header.toLowerCase().split(",")) {
    const [coding = "", ...params] = part.split(";").map((s) => s.trim())
    const q = params.find((p) => p.startsWith("q="))
    const accepted = q === undefined || Number(q.slice(2)) > 0
    if (coding === name) return accepted
    if (coding === "*") wildcard = accepted
  }
  return wildcard === true
}

const isNotFound = (e: HttpServerError.HttpServerError): boolean => e.reason._tag === "RouteNotFound"

/**
 * Serves a file of the UI as the build's `.br` or `.gz` beside it when the browser accepts that encoding, else as it is
 * (docs/plan/09-frontend.md, The bundle). A variant is served by the same static server under its own name, so its
 * ETag, its 304s and its ranges are its own; this puts back the file's type and says how it is encoded. With no
 * variant on disk (a build from before, a file too small to compress), the file itself.
 */
const servePrecompressed = (
  serve: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError.HttpServerError, HttpServerRequest.HttpServerRequest>,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError.HttpServerError> => {
  const plain = Effect.provideService(serve, HttpServerRequest.HttpServerRequest, request)
  const queryAt = request.url.indexOf("?")
  const pathname = queryAt === -1 ? request.url : request.url.slice(0, queryAt)
  const query = queryAt === -1 ? "" : request.url.slice(queryAt)
  const extension = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase()
  const type = pathname.includes(".") ? compressibleTypes[extension] : undefined
  if (type === undefined) return plain
  const accept = request.headers["accept-encoding"]
  const chosen = encodings
    .filter((encoding) => acceptsEncoding(accept, encoding.name))
    .reduceRight(
      (fallback, encoding) =>
        Effect.provideService(serve, HttpServerRequest.HttpServerRequest, request.modify({ url: `${pathname}${encoding.suffix}${query}` })).pipe(
          Effect.map((response) =>
            response.status === 200 || response.status === 206
              ? HttpServerResponse.setHeaders(response, { "content-type": type, "content-encoding": encoding.name })
              : response,
          ),
          Effect.catchIf(isNotFound, () => fallback),
        ),
      plain,
    )
  // Every answer for a file that has variants depends on what the browser accepts, its 304s included.
  return Effect.map(chosen, (response) => HttpServerResponse.setHeader(response, "vary", "Accept-Encoding"))
}

/**
 * The largest request body read: an attachment's 10 MiB as base64 in one RPC, with room (docs/plan/inventory/
 * 07-server-root-api.md, 7.3). A larger one is answered 413 without being kept in memory; the RPC's own framing
 * refuses messages over 16 MiB anyway.
 */
export const MAX_BODY = ByteSize.mebibytes(16)

export const BodyLimit = HttpRouter.middleware((app) => Effect.provideService(app, HttpIncomingMessage.MaxBodySize, MAX_BODY), { global: true })
