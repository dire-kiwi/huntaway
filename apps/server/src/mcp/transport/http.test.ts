import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Queue, Redacted, Schema, Stream } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import type { HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { Timestamp } from "@huntaway/contracts"
import { fakeAgent, TestBoard, TestMcp, TestMcpOver, TestTools } from "@huntaway/testing"
import type { McpRunSettings } from "../../agents/AgentDriver.ts"
import { Identity } from "../../platform/Identity.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { RunRepo } from "../../runs/RunRepo.ts"
import { McpHttpRoute, RETRY_MS } from "./http.ts"

// The board's MCP servers over HTTP (docs/plan/inventory/03-mcp.md 2.2): the old mcp/http.test.ts's cases with the test
// tools, on a real HTTP server on a free port: each run's secret, the JSON-RPC, a call answered on an event stream with
// its priming event, and the answer of a call whose stream broke given on the stream its client reconnects with
// (`Last-Event-ID`), across a restart too. gh's, docs' and desktop's own tools come with their servers (M4, M6).

/** The route on a test HTTP server, over `board` (the MCP area and the whole board's services). */
const served = <ROut, E, R>(board: Layer.Layer<ROut, E, R>) =>
  HttpRouter.serve(McpHttpRoute, { disableListenLog: true, disableLogger: true }).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(board))

/** A running run with its servers' settings (as its launch writes them), its secret, and its servers' paths. */
const running = (settings: Partial<McpRunSettings> = {}) =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent()
    yield* (yield* RunDir)
      .writeMcpRun(agent.run.id, { cwd: "/tmp", github_account: null, review: false, in_process: false, desktop: false, ...settings })
      .pipe(Effect.orDie)
    const secret = yield* (yield* Identity).runSecret(agent.run.id)
    return { agent, secret, path: (server = "huntaway") => `/api/mcp/${agent.run.id}/${server}` }
  })

const send = (request: HttpClientRequest.HttpClientRequest) => Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request)).pipe(Effect.orDie)

const post = (path: string, secret: string, message: unknown, accept = "application/json, text/event-stream") =>
  send(
    HttpClientRequest.post(path).pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${secret}`, accept }), HttpClientRequest.bodyJsonUnsafe(message)),
  )

const reconnect = (path: string, secret: string, last: string) =>
  send(
    HttpClientRequest.get(path).pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${secret}`, accept: "text/event-stream", "last-event-id": last })),
  )

const Response = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Unknown),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Struct({ progressToken: Schema.Unknown, progress: Schema.Finite })),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
})

const body = (response: HttpClientResponse.HttpClientResponse) => Effect.flatMap(response.json, Schema.decodeUnknownEffect(Response)).pipe(Effect.orDie)

const CallResult = Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })), isError: Schema.optional(Schema.Boolean) })
const said = (result: unknown): readonly [string, boolean] =>
  Schema.is(CallResult)(result) ? [result.content[0]?.text ?? "", result.isError === true] : assert.fail("not a tool's result")

const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
const names = (result: unknown) => (Schema.is(ToolList)(result) ? result.tools.map((t) => t.name) : assert.fail("not a tool list"))

interface SseEvent {
  readonly id?: string
  readonly event?: string
  readonly retry?: string
  readonly data: string
}

/** A field of an event, as a line of the stream gives it. */
const withField = (event: SseEvent | null, line: string): SseEvent => {
  const at = line.indexOf(":")
  const [key, value] = at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 1).replace(/^ /, "")]
  const base = event ?? { data: "" }
  if (key === "data") return { ...base, data: base.data + value }
  if (key === "id") return { ...base, id: value }
  if (key === "event") return { ...base, event: value }
  if (key === "retry") return { ...base, retry: value }
  return base
}

/** Server-sent events off a response, one at a time; `close` drops the connection, as a client does. */
const events = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SseEvent>()
    const reading = yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapAccum(
        (): SseEvent | null => null,
        (event, line): readonly [SseEvent | null, ReadonlyArray<SseEvent>] =>
          line === "" ? [null, event === null ? [] : [event]] : line.startsWith(":") ? [event, []] : [withField(event, line), []],
      ),
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkChild,
    )
    return { next: Queue.take(queue), close: Fiber.interrupt(reading) }
  })

const message = (event: SseEvent) => Schema.decodeEffect(Schema.fromJsonString(Response))(event.data).pipe(Effect.orDie)

const touched = Effect.flatMap(TestTools, (tools) => tools.touched)

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }

describe("MCP over HTTP", () => {
  it.effect("a run's servers take only its own secret", () =>
    Effect.gen(function* () {
      const identity = yield* Identity
      const run = yield* running()
      const other = yield* running()
      assert.notStrictEqual(run.secret, other.secret)
      assert.strictEqual(run.secret.length, 64)
      assert.strictEqual((yield* post(run.path(), run.secret, init)).status, 200)
      // Another run's secret, the board token, none at all.
      for (const secret of [other.secret, Redacted.value(identity.token), ""]) assert.strictEqual((yield* post(run.path(), secret, init)).status, 401, secret)
      assert.isTrue(yield* identity.isRunSecret(run.agent.run.id, run.secret))
      assert.isFalse(yield* identity.isRunSecret(run.agent.run.id, other.secret))
      // Only the board's servers.
      assert.strictEqual((yield* post(run.path("other"), run.secret, init)).status, 404)
      // A run whose launch didn't record its servers' settings.
      const bare = yield* fakeAgent()
      const secret = yield* identity.runSecret(bare.run.id)
      const response = yield* post(`/api/mcp/${bare.run.id}/huntaway`, secret, init)
      assert.strictEqual(response.status, 404)
      assert.deepStrictEqual(yield* response.json, { error: "unknown run" })
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("a run that calls the board on its output has only the other servers here, and desktop only if launched with it", () =>
    Effect.gen(function* () {
      const inProcess = yield* running({ in_process: true })
      const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "test_echo", arguments: { text: "x" } } }
      assert.strictEqual((yield* post(inProcess.path(), inProcess.secret, init)).status, 404)
      assert.strictEqual((yield* post(inProcess.path(), inProcess.secret, call)).status, 404)
      assert.strictEqual((yield* post(inProcess.path("gh"), inProcess.secret, init)).status, 200)
      assert.strictEqual((yield* post(inProcess.path("desktop"), inProcess.secret, init)).status, 404)
      const desktop = yield* running({ desktop: true })
      const response = yield* post(desktop.path("desktop"), desktop.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "application/json")
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(names((yield* body(response)).result), [])
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("lists and calls the board's tools", () =>
    Effect.gen(function* () {
      const run = yield* running()
      const answer = yield* body(yield* post(run.path(), run.secret, init))
      const InitializeResult = Schema.Struct({ protocolVersion: Schema.String, serverInfo: Schema.Struct({ name: Schema.String }) })
      const result = yield* Schema.decodeUnknownEffect(InitializeResult)(answer.result).pipe(Effect.orDie)
      assert.deepStrictEqual([result.protocolVersion, result.serverInfo.name], ["2025-11-25", "huntaway"])
      // Notifications get no answer; nor do GETs for a stream of the server's own, or sessions to end.
      assert.strictEqual((yield* post(run.path(), run.secret, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202)
      const auth = { authorization: `Bearer ${run.secret}` }
      assert.strictEqual(
        (yield* send(HttpClientRequest.get(run.path()).pipe(HttpClientRequest.setHeaders({ ...auth, accept: "text/event-stream" })))).status,
        405,
      )
      assert.strictEqual((yield* send(HttpClientRequest.delete(run.path()).pipe(HttpClientRequest.setHeaders(auth)))).status, 405)
      assert.strictEqual((yield* post(run.path(), run.secret, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400)
      const bad = yield* send(HttpClientRequest.post(run.path()).pipe(HttpClientRequest.setHeaders(auth), HttpClientRequest.bodyText("{", "application/json")))
      assert.deepStrictEqual([bad.status, (yield* body(bad)).error?.code], [400, -32700])
      assert.strictEqual((yield* body(yield* post(run.path(), run.secret, { jsonrpc: "2.0", id: 2, method: "server/discover" }))).error?.code, -32601)
      const listed = names((yield* body(yield* post(run.path(), run.secret, { jsonrpc: "2.0", id: 3, method: "tools/list" }))).result)
      assert.isTrue(listed.includes("test_touch") && !listed.includes("submit_test_review"), listed.join())

      // A call is answered on an event stream: its priming event (an id, a retry time, no data), then the answer.
      const response = yield* post(run.path(), run.secret, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "test_echo", arguments: { text: "hi" } },
      })
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      const stream = yield* events(response)
      const prime = yield* stream.next
      assert.deepStrictEqual([prime.data, prime.retry], ["", String(RETRY_MS)])
      assert.isTrue(prime.id !== undefined && prime.id.startsWith("huntaway."))
      const last = yield* stream.next
      assert.strictEqual(last.event, "message")
      const v = yield* message(last)
      assert.strictEqual(v.id, 4)
      const [text, error] = said(v.result)
      assert.isFalse(error, text)
      assert.include(text, run.agent.run.task_id)
      // The call went to the board as the run's.
      const rows = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly run_id: string }>`SELECT run_id FROM mcp_calls`).pipe(Effect.orDie)
      assert.deepStrictEqual(
        rows.map((r) => r.run_id),
        [run.agent.run.id],
      )

      // A client that doesn't take event streams gets JSON once it is done.
      const plain = yield* body(
        yield* post(
          run.path(),
          run.secret,
          { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "test_echo", arguments: { text: "plain" } } },
          "application/json",
        ),
      )
      assert.include(said(plain.result)[0], '"text": "plain"')
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("a review's server offers the reviewers' tools", () =>
    Effect.gen(function* () {
      const run = yield* running({ review: true })
      const listed = names((yield* body(yield* post(run.path(), run.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" }))).result)
      assert.isTrue(listed.includes("submit_test_review") && !listed.includes("test_touch"), listed.join())
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("a call whose stream broke is answered when the client reconnects, with progress on its streams", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const run = yield* running()
      const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "test_block", arguments: { key: "k" }, _meta: { progressToken: 3 } } }
      const first = yield* events(yield* post(run.path(), run.secret, call))
      const last = (yield* first.next).id ?? assert.fail("no event id")
      // Claude Code drops a call 90 seconds after its stream broke unless it has had progress since.
      const progress = yield* message(yield* first.next)
      assert.deepStrictEqual([progress.method, progress.params?.progressToken], ["notifications/progress", 3])
      yield* tools.blocked("k")
      // The connection goes (the client's, or a proxy's): the call stays.
      yield* first.close
      const again = yield* events(yield* reconnect(run.path(), run.secret, last))
      // The new stream has the same id, so it can be resumed in turn.
      assert.strictEqual((yield* again.next).id, last)
      const note = yield* message(yield* again.next)
      assert.strictEqual(note.method, "notifications/progress")
      assert.isTrue((note.params?.progress ?? -1) >= (progress.params?.progress ?? 0))
      yield* tools.release("k")
      const answer = yield* message(yield* again.next)
      assert.deepStrictEqual([answer.id, said(answer.result)], [7, ['{\n  "key": "k"\n}', false]])
      // Once only; and answered while the client was away, its answer is the one recorded.
      assert.deepStrictEqual(yield* touched, ["block:k"])
      const third = yield* events(yield* reconnect(run.path(), run.secret, last))
      yield* third.next
      yield* third.next
      assert.deepStrictEqual(said((yield* message(yield* third.next)).result), ['{\n  "key": "k"\n}', false])
      assert.deepStrictEqual(yield* touched, ["block:k"])
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("a call cut short by a restart carries on when the client reconnects, if it can", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const run = yield* running()
      const post_ = (name: string, key: string) =>
        Effect.gen(function* () {
          const stream = yield* events(
            yield* post(run.path(), run.secret, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: { key } } }),
          )
          const id = (yield* stream.next).id ?? assert.fail("no event id")
          yield* tools.blocked(key)
          // Its stream is dropped as the server goes.
          yield* stream.close
          return id
        })
      const [waitId, blockId] = yield* Effect.all([post_("wait", "w"), post_("test_block", "b")], { concurrency: 1 }).pipe(
        Effect.provide(served(TestMcpOver())),
      )
      // The server is back.
      yield* Effect.gen(function* () {
        const resumed = yield* events(yield* reconnect(run.path(), run.secret, waitId))
        yield* resumed.next
        yield* tools.release("w")
        assert.deepStrictEqual(said((yield* message(yield* resumed.next)).result), ['{\n  "key": "w"\n}', false])
        const lost = yield* events(yield* reconnect(run.path(), run.secret, blockId))
        yield* lost.next
        const [text, error] = said((yield* message(yield* lost.next)).result)
        assert.isTrue(error && text.includes("was interrupted"), text)
        assert.deepStrictEqual(yield* touched, ["block:b"])
      }).pipe(Effect.provide(served(TestMcpOver())))
    }).pipe(Effect.provide(Layer.provideMerge(TestTools.layer, TestBoard()))),
  )

  it.effect("a resumed call the board never got, or another run's, is refused", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const run = yield* running()
      const other = yield* running()
      // The server stopped before it recorded the call: it wasn't run, so the agent can call it again.
      const never = yield* events(yield* reconnect(run.path(), run.secret, `huntaway.c0.${Base64Url.encode("9")}`))
      yield* never.next
      const v = yield* message(yield* never.next)
      const [text, error] = said(v.result)
      assert.isTrue(v.id === 9 && error && text.includes("wasn't run"), text)

      const stream = yield* events(
        yield* post(run.path(), run.secret, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait", arguments: { key: "w" } } }),
      )
      const last = (yield* stream.next).id ?? assert.fail("no event id")
      yield* tools.blocked("w")
      assert.strictEqual((yield* reconnect(other.path(), other.secret, last)).status, 404)
      // Nor on another server, or garbled.
      for (const bad of [last, "nonsense"]) assert.strictEqual((yield* reconnect(run.path("gh"), run.secret, bad)).status, 404, bad)
      yield* tools.release("w")
    }).pipe(Effect.provide(served(TestMcp()))),
  )

  it.effect("a run the board has ended gets no calls on any server", () =>
    Effect.gen(function* () {
      const run = yield* running()
      yield* (yield* RunRepo).end(run.agent.run.id, Timestamp.make("2026-11-12T00:00:00.000Z"))
      // Each with arguments it takes (gh's tools check theirs first, as the board's do).
      for (const [server, tool, args] of [
        ["gh", "git_push", {}],
        ["docs", "publish_document", { label: "x" }],
        ["huntaway", "test_touch", { label: "x" }],
      ] as const) {
        const v = yield* body(
          yield* post(
            run.path(server),
            run.secret,
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
            "application/json",
          ),
        )
        const [text, error] = said(v.result)
        assert.isTrue(error && text.includes("has ended on the board"), `${server}: ${text}`)
      }
      assert.deepStrictEqual(yield* touched, [])
    }).pipe(Effect.provide(served(TestMcp()))),
  )
})
