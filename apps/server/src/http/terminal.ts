import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Terminals } from "../terminal/Terminals.ts"
import { size } from "../terminal/tmux.ts"

const one = (v: string | ReadonlyArray<string> | undefined): string | undefined => (typeof v === "string" ? v : v?.[0])

/**
 * `GET /api/terminal/<ticket>?cols=&rows=` (docs/plan/05-protocol.md, Plain HTTP): a task's terminal as a websocket,
 * opened by a ticket from `terminal.open` (a browser can't put the board token on a websocket, and a long-lived token
 * mustn't sit in a URL). A bad ticket, a task that's gone or a host without tmux is answered before the upgrade.
 */
export const TerminalRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const terminals = yield* Terminals
    yield* router.add("GET", "/api/terminal/:ticket", (request) =>
      Effect.gen(function* () {
        const ticket = (yield* HttpRouter.params)["ticket"] ?? ""
        const query = yield* HttpServerRequest.ParsedSearchParams
        return yield* terminals.serve(ticket, { cols: size(one(query["cols"]), 80), rows: size(one(query["rows"]), 24) }, request.upgrade).pipe(
          Effect.as(HttpServerResponse.empty()),
          Effect.catchTags({
            TicketInvalid: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "no such terminal ticket, or it expired" }, { status: 403 })),
            TaskNotFound: (e) => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: `task ${e.id} not found` }, { status: 404 })),
            TerminalUnavailable: (e) => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.reason }, { status: 503 })),
          }),
          Effect.orDie,
        )
      }),
    )
  }),
)
