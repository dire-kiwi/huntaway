import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { accept, dial, pipe } from "../hosts/pipe.ts"
import { Spaces } from "../spaces/Spaces.ts"
import { requestHeaders, responseHeaders } from "../spaces/spacesd.ts"

const PREFIX = "/api/spaces/v/"

/**
 * `/api/spaces/v/<ticket>/…` (HE-35; docs/plan/05-protocol.md, Plain HTTP): a Space's spacesd, relayed, for its viewer
 * in the board. The ticket (from `spaces.view`, good for an hour, for any number of requests) names the Space; the rest
 * of the path goes to its spacesd as it is: the viewer's page, its gRPC-Web calls (which carry spacesd's viewer ticket)
 * and its media WebSocket, piped frame for frame with each side's pace passed to the other. spacesd's own token is never
 * added: the viewer's ticket is all a viewer's calls may use.
 */
export const SpacesRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const spaces = yield* Spaces
    const http = yield* HttpClient.HttpClient
    yield* router.add("*", "/api/spaces/v/:ticket/*", (request) =>
      Effect.gen(function* () {
        const ticket = (yield* HttpRouter.params)["ticket"] ?? ""
        const target = yield* spaces.relayTarget(ticket)
        if (target === null)
          return HttpServerResponse.jsonUnsafe({ error: "no such Space viewer ticket, or it expired: open the Space again" }, { status: 403 })
        const prefix = `${PREFIX}${ticket}`
        const rest = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : "/"
        const path = rest.startsWith("/") ? rest : `/${rest}`
        if ((request.headers["upgrade"] ?? "").toLowerCase() === "websocket") {
          const protocols = (request.headers["sec-websocket-protocol"] ?? "")
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p !== "")
          const client = yield* accept
          const space = yield* dial(`ws://127.0.0.1:${target.port}${path}`, { protocols, openTimeout: "15 seconds" })
          yield* pipe(client, space)
          return HttpServerResponse.empty()
        }
        if (!HttpMethod.isHttpMethod(request.method)) return HttpServerResponse.empty({ status: 405 })
        const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(yield* request.arrayBuffer)
        const forwarded = HttpClientRequest.make(request.method)(`http://127.0.0.1:${target.port}${path}`).pipe(
          HttpClientRequest.setHeaders(requestHeaders(request.headers)),
          (r) => (body === null ? r : HttpClientRequest.bodyUint8Array(r, body, request.headers["content-type"])),
        )
        // A redirect goes back to the browser (its `location` kept under the relay), never followed by this server: what
        // answers on the Space's port is the Space's to choose, and must not reach the host's loopback through it.
        const answer = yield* http.execute(forwarded).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
        return HttpServerResponse.stream(answer.stream, { status: answer.status, headers: responseHeaders(answer.headers, prefix) })
      }).pipe(
        Effect.catchTags({
          HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          HttpClientError: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "the Space isn't answering" }, { status: 502 })),
        }),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      ),
    )
  }),
)
