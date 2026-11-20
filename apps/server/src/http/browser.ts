import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Browsers, DEFAULT_SIZE } from "../browser/Browsers.ts"

const one = (v: string | ReadonlyArray<string> | undefined): string | undefined => (typeof v === "string" ? v : v?.[0])
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/**
 * `GET /api/browser/<ticket>?width=&height=&url=` (HE-62; docs/plan/05-protocol.md, Plain HTTP): a task's browser as a
 * websocket, opened by a ticket from `browser.open`: a viewer of its headless page's stream, or the desktop app's pane
 * handing its <webview> to the server (`Browsers.serve`). A bad ticket is answered before the upgrade.
 */
export const BrowserRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const browsers = yield* Browsers
    yield* router.add("GET", "/api/browser/:ticket", (request) =>
      Effect.gen(function* () {
        const ticket = (yield* HttpRouter.params)["ticket"] ?? ""
        const query = yield* HttpServerRequest.ParsedSearchParams
        const url = one(query["url"]) ?? ""
        return yield* browsers
          .serve(
            ticket,
            { width: int(one(query["width"]), DEFAULT_SIZE.width), height: int(one(query["height"]), DEFAULT_SIZE.height), url: url === "" ? null : url },
            request.upgrade,
          )
          .pipe(
            Effect.as(HttpServerResponse.empty()),
            Effect.catchTag("BrowserTicketInvalid", () =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "no such browser ticket, or it expired" }, { status: 403 })),
            ),
            Effect.orDie,
          )
      }),
    )
  }),
)
