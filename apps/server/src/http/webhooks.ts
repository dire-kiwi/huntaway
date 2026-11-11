import { ByteSize, Effect, Option } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import { MAX_BODY } from "../automations/model.ts"
import { Webhooks } from "../automations/Webhooks.ts"

// `POST /api/hooks/<id>/<token>` (docs/plan/05-protocol.md, Plain HTTP): an automation's webhook, with no board token
// (the token in the path is the automation's own). Same path as the old server's, so URLs registered elsewhere keep
// working. Bodies over 1 MiB get a 413.

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status })

export const WebhookRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const webhooks = yield* Webhooks
    const handler = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const params = yield* HttpRouter.params
      const id = params["id"]
      const token = params["token"]
      if (id === undefined || token === undefined) return json(404, { error: "no such webhook" })
      const body = yield* Effect.option(Effect.provideService(request.arrayBuffer, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY)))
      if (Option.isNone(body)) return json(413, { error: `the body is over ${MAX_BODY} bytes` })
      const q = request.url.indexOf("?")
      const answer = yield* webhooks.deliver(id, token, request.headers, q < 0 ? null : request.url.slice(q + 1), new Uint8Array(body.value))
      return json(answer.status, answer.body)
    })
    yield* router.add("POST", "/api/hooks/:id/:token", (request) => handler(request).pipe(Effect.annotateLogs({ module: "webhooks" })))
  }),
)
