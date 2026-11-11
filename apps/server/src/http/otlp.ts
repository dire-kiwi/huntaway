import { ByteSize, DateTime, Effect, Option, Schema, Stream } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import { RunId } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { Telemetry } from "../platform/Telemetry.ts"
import { mapRequest, OTLP_MAX_BODY } from "../platform/telemetry/otlp.ts"

// The receiver of the agents' own OpenTelemetry (docs/plan/05-protocol.md, Plain HTTP; the old telemetry/otlp.ts's
// `serve`): `POST /api/otlp/<run id>/v1/(logs|metrics|traces)` with the run's own secret as its bearer token, so a run
// can only send as itself. Only OTLP/JSON, at most 4 MiB gzipped or not. Metrics and traces aren't asked for: taken and
// dropped, so an agent that sends them doesn't retry. A log request's records become `agent_events` rows of the run's
// task (`Telemetry.agentEvents`, which keeps them only if its profile sends).

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status })
const JsonValue = Schema.fromJsonString(Schema.Unknown)

class TooBig extends Schema.TaggedError<TooBig, { readonly brand: unique symbol }>()("TooBig", {}) {}

/** A gzipped body, inflated up to the limit. */
const gunzip = (bytes: Uint8Array) =>
  Stream.fromReadableStream({
    evaluate: () => new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    onError: () => new TooBig(),
  }).pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
      (acc, chunk: Uint8Array) =>
        acc.size + chunk.length > OTLP_MAX_BODY ? Effect.fail(new TooBig()) : Effect.succeed({ chunks: [...acc.chunks, chunk], size: acc.size + chunk.length }),
    ),
    Effect.map(({ chunks, size }) => {
      const out = new Uint8Array(size)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    }),
  )

export const OtlpRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const identity = yield* Identity
    const telemetry = yield* Telemetry

    const serve = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const params = yield* HttpRouter.params
      const signal = params["signal"]
      if (params["run"] === undefined || (signal !== "logs" && signal !== "metrics" && signal !== "traces")) return json(404, { error: "not found" })
      const run = RunId.make(params["run"])
      const auth = request.headers["authorization"]
      const authorised = auth !== undefined && auth.startsWith("Bearer ") && (yield* identity.isRunSecret(run, auth.slice("Bearer ".length)))
      if (!authorised) return json(401, { error: "unauthorized" })
      if (!(request.headers["content-type"] ?? "").includes("json")) return json(415, { error: "only OTLP/JSON is taken" })
      const raw = yield* Effect.option(Effect.provideService(request.arrayBuffer, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(OTLP_MAX_BODY)))
      if (Option.isNone(raw)) return json(413, { error: "over 4 MB" })
      const gzipped = (request.headers["content-encoding"] ?? "").includes("gzip")
      const body = gzipped ? yield* Effect.option(gunzip(new Uint8Array(raw.value))) : Option.some(new Uint8Array(raw.value))
      if (Option.isNone(body)) return json(413, { error: "over 4 MB" })
      if (signal !== "logs") return json(200, {})
      const value = Schema.decodeOption(JsonValue)(new TextDecoder().decode(body.value))
      if (Option.isNone(value)) return json(400, { error: "not JSON" })
      const now = DateTime.formatIso(yield* DateTime.now)
      yield* telemetry.agentEvents(run, mapRequest(value.value, now))
      return json(200, {})
    })

    const handler = (request: HttpServerRequest.HttpServerRequest) => serve(request).pipe(Effect.annotateLogs({ module: "telemetry" }))
    yield* router.add("POST", "/api/otlp/:run/v1/:signal", handler)
  }),
)
