import { ByteSize, Clock, Effect, Option, Result, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import { CallId, RunId } from "@huntaway/contracts"
import { Identity } from "../../platform/Identity.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { callParams, callResult, INVALID_REQUEST, PARSE_ERROR, readMessage, rpcError, rpcResult, toolError } from "../jsonrpc.ts"
import type { RpcId, RpcResponse } from "../jsonrpc.ts"
import { McpCallRepo } from "../McpCallRepo.ts"
import { McpServers } from "../McpServers.ts"
import { BOARD_SERVER, ServerName } from "../tool.ts"
import { ToolCalls } from "../ToolCalls.ts"

// The board's MCP servers over HTTP, MCP's streamable HTTP transport (docs/plan/inventory/03-mcp.md 2.2;
// docs/plan/05-protocol.md, Plain HTTP): `/api/mcp/<run id>/<server>` on the host's internal URL, each run with a
// secret of its own as its bearer token (`Identity.runSecret`), so a run can only act as itself and never holds the
// board token. Every run reaches gh's, docs' and desktop's servers here; the board's own only compactions and Codex
// sessions that took no dynamic tools (Claude runs that take input call it on their output, `control.ts`).
//
// A call is answered as a server-sent event stream that starts with an event that has an id and no data (MCP's priming
// event) and a `retry` time. If the stream breaks, as it does when this server restarts, Claude Code and Codex
// reconnect with a GET that names that id (`Last-Event-ID`), and the call's answer comes on that stream instead: the
// id names the call in `mcp_calls`, which carries on as at-most-once has it (a wait keeps waiting, a finished call's
// answer is the one recorded, a call a restart cut short says so). Claude Code also drops a call 90 seconds after its
// connection broke unless it has had progress since, so a call with a progress token gets a progress notification when
// its stream opens and every 20 seconds after.

/** How long a client waits before it reconnects to a call's broken stream, in ms. */
export const RETRY_MS = 5000

/** A progress notification (or a comment) on a call's stream this often. */
export const KEEPALIVE = "20 seconds"

/** The largest request a server takes; the docs server's is larger, for `publish_document`'s images. */
const BODY_LIMIT = ByteSize.mebibytes(32)
const DOCS_BODY_LIMIT = ByteSize.mebibytes(64)

const json = (status: number, body: unknown, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.jsonUnsafe(body, headers === undefined ? { status } : { status, headers })

const notFound = json(404, { error: "not found" })
const notAllowed = json(405, rpcError(null, -32000, "Method not allowed"), { allow: "POST" })
const unknownEvent = json(404, rpcError(null, -32000, "unknown event id"))

const JsonValue = Schema.fromJsonString(Schema.Unknown)
const encodeJson = (value: unknown) => Schema.encodeEffect(JsonValue)(value).pipe(Effect.orDie)

const b64 = (value: unknown) => Effect.map(encodeJson(value ?? null), (text) => Base64Url.encode(text))
const unb64 = (text: string): Option.Option<unknown> =>
  Result.match(Base64Url.decodeString(text), {
    onFailure: () => Option.none(),
    onSuccess: (decoded) => Schema.decodeOption(JsonValue)(decoded),
  })

/** A call's stream's event id: its server, its call, the request's JSON-RPC id, and its progress token if it has one. */
const eventId = Effect.fnUntraced(function* (server: ServerName, call: CallId, rpcId: RpcId, progress: RpcId | undefined) {
  return `${server}.${call}.${yield* b64(rpcId)}${progress === undefined ? "" : `.${yield* b64(progress)}`}`
})

const EVENT_ID = /^([a-z_]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_-]*))?$/

const isRpcId = (u: unknown): u is RpcId => typeof u === "string" || typeof u === "number"

/** What an event id names, if it is one. */
const parseEventId = (id: string) => {
  const m = EVENT_ID.exec(id)
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  const rpcId = Option.getOrUndefined(unb64(m[3]))
  const progress = m[4] === undefined ? undefined : Option.getOrUndefined(unb64(m[4]))
  if (!isRpcId(rpcId) || (m[4] !== undefined && !isRpcId(progress))) return null
  return { server: m[1], call: CallId.make(m[2]), rpcId, progress: isRpcId(progress) ? progress : undefined }
}

/** One server-sent event carrying a JSON-RPC message. */
const messageEvent = (event: string, message: unknown) => Effect.map(encodeJson(message), (data) => `id: ${event}\nevent: message\ndata: ${data}\n\n`)

/**
 * Answer a call: on an event stream if the client takes one (both CLIs do), else as JSON once it is done. The answer
 * is awaited only by this response: a client that goes away leaves the call running (it runs in `ToolCalls`' fibers).
 */
const reply = (stream: boolean, event: string, progress: RpcId | undefined, answer: Effect.Effect<RpcResponse>) => {
  if (!stream) return Effect.map(answer, (response) => json(200, response))
  const tick = Effect.gen(function* () {
    if (progress === undefined) return ": keepalive\n\n"
    // Its value only has to grow, across a restart too.
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    return yield* messageEvent(event, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: progress, progress: now } })
  })
  const ticks = Stream.tick(KEEPALIVE).pipe(Stream.mapEffect(() => tick, { concurrency: 1 }))
  const last = Stream.fromEffect(Effect.flatMap(answer, (response) => messageEvent(event, response)))
  const body = Stream.concat(Stream.make(`id: ${event}\nretry: ${RETRY_MS}\ndata: \n\n`), Stream.merge(ticks, last, { haltStrategy: "right" }))
  return Effect.succeed(HttpServerResponse.stream(Stream.encodeText(body), { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } }))
}

/** `POST|GET /api/mcp/<run id>/<server>`, beside the other routes (mounted in `Main.ts`). */
export const McpHttpRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const identity = yield* Identity
    const dirs = yield* RunDir
    const servers = yield* McpServers
    const toolCalls = yield* ToolCalls
    const calls = yield* McpCallRepo
    const random = yield* SecureRandom.SecureRandom

    /** The board's call, as a tools/call answer. */
    const board = (call: CallId, run: RunId, server: ServerName, rpcId: RpcId, tool: string, args: unknown) =>
      toolCalls.call({ call_id: call, run, server, tool, args }).pipe(
        Effect.flatMap(callResult),
        Effect.map((result) => rpcResult(rpcId, result)),
      )

    /** A client reconnecting for a call's answer (its stream broke): the call's answer comes on this stream. */
    const resume = Effect.fnUntraced(function* (run: RunId, server: ServerName, last: string) {
      const event = parseEventId(last)
      if (event === null || event.server !== server) return unknownEvent
      yield* Effect.logInfo(`run=${run} reconnected for its ${server} call ${event.call}`)
      const found = yield* Effect.result(calls.find(event.call))
      if (Result.isFailure(found)) {
        return yield* reply(
          true,
          last,
          event.progress,
          Effect.succeed(rpcResult(event.rpcId, toolError(`The board couldn't look up this call: ${found.failure.message}. Call it again.`))),
        )
      }
      const row = Option.getOrUndefined(found.success)
      if (row !== undefined && row.run_id !== run) return unknownEvent
      // Not recorded, so it never ran: the server stopped before it got to it.
      if (row === undefined) {
        return yield* reply(
          true,
          last,
          event.progress,
          Effect.succeed(rpcResult(event.rpcId, toolError("The board's server restarted before this call ran, so it wasn't run: call it again."))),
        )
      }
      const args = Option.getOrNull(Schema.decodeOption(JsonValue)(row.args))
      return yield* reply(true, last, event.progress, board(event.call, run, server, event.rpcId, row.tool, args))
    })

    const serve = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const params = yield* HttpRouter.params
      const server = Schema.decodeUnknownOption(ServerName)(params["server"])
      if (Option.isNone(server) || params["run"] === undefined) return notFound
      const run = RunId.make(params["run"])
      const auth = request.headers["authorization"]
      const authorised = auth !== undefined && auth.startsWith("Bearer ") && (yield* identity.isRunSecret(run, auth.slice("Bearer ".length)))
      if (!authorised) return json(401, { error: "unauthorized" })
      const settings = yield* dirs.mcpRun(run)
      if (settings === null) return json(404, { error: "unknown run" })
      // Its board tools are answered on its own output; and only a run launched with the desktop server has it (the
      // run's secret is its gh and docs servers' too).
      if ((settings.in_process && server.value === BOARD_SERVER) || (!settings.desktop && server.value === "desktop")) return notFound

      if (request.method === "GET") {
        const last = request.headers["last-event-id"]
        // No stream of the server's own: it sends nothing but answers.
        return last === undefined ? notAllowed : yield* resume(run, server.value, last)
      }
      if (request.method !== "POST") return notAllowed

      const limit = server.value === "docs" ? DOCS_BODY_LIMIT : BODY_LIMIT
      const text = yield* Effect.option(Effect.provideService(request.text, HttpIncomingMessage.MaxBodySize, limit))
      const body = Option.flatMap(text, (t) => Schema.decodeOption(JsonValue)(t))
      if (Option.isNone(body)) return json(400, rpcError(null, PARSE_ERROR, "Parse error"))
      if (Array.isArray(body.value)) return json(400, rpcError(null, INVALID_REQUEST, "batches aren't supported"))
      const message = readMessage(body.value)
      // Notifications (`initialized`, `cancelled`) and responses get no answer.
      if (message._tag !== "Request" || message.method === "") return HttpServerResponse.empty({ status: 202 })
      if (message.method !== "tools/call") return json(200, yield* servers.answer(server.value, settings.review, message))

      const call = CallId.make(yield* random.uuidV4().pipe(Effect.orDie))
      const { name, args, progressToken } = callParams(message.params)
      const event = yield* eventId(server.value, call, message.id, progressToken)
      const stream = (request.headers["accept"] ?? "").includes("text/event-stream")
      return yield* reply(stream, event, progressToken, board(call, run, server.value, message.id, name, args))
    })

    const handler = (request: HttpServerRequest.HttpServerRequest) => serve(request).pipe(Effect.annotateLogs({ module: "mcp" }))
    yield* router.add("POST", "/api/mcp/:run/:server", handler)
    yield* router.add("GET", "/api/mcp/:run/:server", handler)
    yield* router.add("DELETE", "/api/mcp/:run/:server", handler)
  }),
)
