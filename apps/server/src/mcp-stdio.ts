import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option, Predicate, Ref, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http"
import { writeSync } from "node:fs"

// `huntaway mcp-stdio <url>` (HE-69; docs/plan/07-agents.md, ACP agents): a stdio MCP server that is the board's MCP
// server at `url` (MCP's streamable HTTP transport, mcp/transport/http.ts), for an agent that only takes stdio MCP
// servers (Antigravity). Each JSON-RPC message on its stdin is POSTed to `url` with the headers in
// `HUNTAWAY_MCP_HEADERS` (a JSON object: the run's bearer secret) and the `Mcp-Session-Id` the server gave, if it gave
// one; each JSON-RPC message of the answer (a JSON body, or the `data` of a server-sent event stream: a call's progress
// notifications and its result; events without data, the priming event and keepalives, are skipped) is written to its
// stdout, one to a line. A notification's 202 writes nothing. Messages are sent as they come, each on its own request (a batch's too),
// so a long call (the board's `wait`) doesn't hold up the others. A call whose event stream breaks before its answer (the
// board restarting) is asked for again with a GET naming the last event's id (`Last-Event-ID`), as Claude Code and Codex
// do, every `retry` milliseconds the stream said, up to 120 times. A request the board couldn't answer is answered with a
// JSON-RPC error. It exits when its stdin ends.

const url = process.argv[2] ?? ""

/** A whole line, at once (see codex-run.ts). */
const writeAll = (fd: number, text: string) =>
  Effect.sync(() => {
    const bytes = Buffer.from(text, "utf8")
    let at = 0
    while (at < bytes.length) {
      try {
        at += writeSync(fd, bytes, at)
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "EAGAIN")) return
      }
    }
  })

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = Schema.decodeUnknownOption(Json)
const encode = Schema.encodeUnknownOption(Json)
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const text = (v: unknown) => Option.getOrElse(encode(v), () => "null")
const warn = (s: string) => writeAll(2, `huntaway mcp-stdio: ${s}\n`)

/** The headers from `HUNTAWAY_MCP_HEADERS`: its string fields. */
const headers: Readonly<Record<string, string>> = (() => {
  const v = Option.getOrUndefined(parse(process.env["HUNTAWAY_MCP_HEADERS"] ?? "{}"))
  return isRecord(v) ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : []))) : {}
})()

/** How many times a broken call's stream is asked for again, at its `retry` time (5 s unless it says). */
const RECONNECTS = 120
const DEFAULT_RETRY_MS = 5000
const SESSION_HEADER = "mcp-session-id"

interface SseEvent {
  readonly id: string | null
  readonly data: string | null
  readonly retry: number | null
}
const noEvent: SseEvent = { id: null, data: null, retry: null }

/** One line of an event stream, over the event it is part of: the event so far, and the event it ended (a blank line). */
const sseLine = (event: SseEvent, line: string): readonly [SseEvent, ReadonlyArray<SseEvent>] => {
  if (line === "") return [noEvent, event.id === null && event.data === null && event.retry === null ? [] : [event]]
  if (line.startsWith(":")) return [event, []]
  const at = line.indexOf(":")
  const key = at < 0 ? line : line.slice(0, at)
  const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /u, "")
  if (key === "data") return [{ ...event, data: event.data === null ? value : `${event.data}\n${value}` }, []]
  if (key === "id") return [{ ...event, id: value }, []]
  if (key === "retry" && /^\d+$/u.test(value)) return [{ ...event, retry: Number(value) }, []]
  return [event, []]
}

/** A message to the agent; true if it is the answer to request `id`. */
const deliver = (message: unknown, id: unknown) =>
  Effect.as(writeAll(1, `${text(message)}\n`), id !== undefined && isRecord(message) && message["id"] === id && !("method" in message))

/** A JSON-RPC error answering request `id`. */
const error = (id: unknown, message: string) => Effect.asVoid(deliver({ jsonrpc: "2.0", id, error: { code: -32603, message } }, id))

/** What a response delivered: whether the answer came, and where its stream may be picked up again. */
interface Read {
  readonly answered: boolean
  readonly last: string | null
  readonly retry: number
}

/** An event stream's messages delivered. */
const readEvents = (response: HttpClientResponse.HttpClientResponse, id: unknown) =>
  Effect.gen(function* () {
    let read: Read = { answered: false, last: null, retry: DEFAULT_RETRY_MS }
    const onEvent = (e: SseEvent) =>
      Effect.gen(function* () {
        read = { ...read, last: e.id ?? read.last, retry: e.retry ?? read.retry }
        if (e.data === null || e.data.trim() === "") return
        const v = Option.getOrUndefined(parse(e.data))
        if (v === undefined) yield* warn(`skipping an event that isn't JSON: ${e.data.slice(0, 200)}`)
        else if (yield* deliver(v, id)) read = { ...read, answered: true }
      })
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapAccum(() => noEvent, sseLine),
      Stream.runForEach(onEvent),
      Effect.ignore,
    )
    return read
  })

const program = Effect.gen(function* () {
  if (url === "") return yield* Effect.fail("usage: huntaway mcp-stdio <url>")
  const client = yield* HttpClient.HttpClient
  const session = yield* Ref.make<string | null>(null)

  const withHeaders = (request: HttpClientRequest.HttpClientRequest, accept: string) =>
    Effect.map(Ref.get(session), (id) => HttpClientRequest.setHeaders(request, { ...headers, accept, ...(id === null ? {} : { [SESSION_HEADER]: id }) }))

  /** A response's messages delivered (its session id kept). */
  const read = (response: HttpClientResponse.HttpClientResponse, id: unknown) =>
    Effect.gen(function* () {
      const sid = response.headers[SESSION_HEADER]
      if (sid !== undefined && sid !== "") yield* Ref.set(session, sid)
      if ((response.headers["content-type"] ?? "").includes("text/event-stream")) return yield* readEvents(response, id)
      const body = yield* Effect.orElseSucceed(response.text, () => "")
      const v = body.trim() === "" ? undefined : Option.getOrUndefined(parse(body))
      let answered = false
      for (const m of Array.isArray(v) ? v : v === undefined ? [] : [v]) if (yield* deliver(m, id)) answered = true
      return { answered, last: null, retry: DEFAULT_RETRY_MS }
    })

  /** A request's broken stream picked up again until its answer comes (the board restarted), or the board says it lost it. */
  const pickUp = (id: unknown, broken: Read) =>
    Effect.gen(function* () {
      let got = broken
      for (let attempt = 0; !got.answered && got.last !== null && attempt < RECONNECTS; attempt++) {
        yield* Effect.sleep(`${got.retry} millis`)
        const again = yield* Effect.result(
          client.execute(yield* withHeaders(HttpClientRequest.setHeader(HttpClientRequest.get(url), "last-event-id", got.last), "text/event-stream")),
        )
        if (again._tag === "Failure") continue
        if (again.success.status >= 400) return yield* error(id, `the board lost this call (${again.success.status}): call it again`)
        const next = yield* read(again.success, id)
        got = { ...next, last: next.last ?? got.last }
      }
      return yield* got.answered ? Effect.void : error(id, "the board's answer didn't come: call it again")
    })

  /** One message from the agent, sent to the board and its answer delivered. */
  const forward = (message: unknown) =>
    Effect.gen(function* () {
      if (!isRecord(message)) return yield* warn(`skipping a line that isn't a JSON-RPC message: ${text(message).slice(0, 200)}`)
      const line = text(message)
      // Only a request (an id and a method) is answered.
      const id = "method" in message && message["id"] !== undefined && message["id"] !== null ? message["id"] : undefined
      const request = yield* withHeaders(
        HttpClientRequest.bodyText(HttpClientRequest.post(url), line, "application/json"),
        "application/json, text/event-stream",
      )
      const sent = yield* Effect.result(client.execute(request))
      if (sent._tag === "Failure") {
        const why = `couldn't reach the board: ${sent.failure.message}`
        return yield* id === undefined ? warn(why) : error(id, why)
      }
      const response = sent.success
      if (response.status === 202 || response.status === 204) return yield* Effect.void
      if (response.status >= 400) {
        const body = yield* Effect.orElseSucceed(response.text, () => "")
        if (id === undefined) return yield* warn(`the board answered ${response.status}: ${body.slice(0, 500)}`)
        // A JSON-RPC error in the body is the server's answer.
        const v = Option.getOrUndefined(parse(body))
        return yield* isRecord(v) && "error" in v
          ? Effect.asVoid(deliver({ ...v, id }, id))
          : error(id, `the board answered ${response.status}: ${body.slice(0, 500)}`)
      }
      const got = yield* read(response, id)
      return yield* id === undefined || got.answered ? Effect.void : pickUp(id, got)
    })

  return yield* Stream.fromAsyncIterable(process.stdin, (e) => e).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((l) => l.trim() !== ""),
    // A batch's messages are sent each on its own, as the board's server takes no batches.
    Stream.runForEach((line) => {
      const v = Option.getOrUndefined(parse(line))
      return Effect.forEach(Array.isArray(v) ? v : [v ?? line], (m) => Effect.forkScoped(forward(m)), { concurrency: 1, discard: true })
    }),
    Effect.ignore,
  )
}).pipe(Effect.scoped)

const main = program.pipe(
  Effect.as(0),
  Effect.catch((e) => writeAll(2, `huntaway mcp-stdio: ${e}\n`).pipe(Effect.as(1))),
  // Its stdin ended: what's still going stops with it.
  Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
)

NodeRuntime.runMain(main)
