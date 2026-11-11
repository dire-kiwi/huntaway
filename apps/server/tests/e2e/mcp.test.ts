import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { startServer } from "./launch.ts"

// The board's MCP server over HTTP on a whole server (docs/plan/05-protocol.md, Plain HTTP): a run's JSON-RPC
// `tools/call` to `/api/mcp/<run>/huntaway`, with the run's secret, answered as an event stream, recorded once in
// `mcp_calls`, and answered again from that record when the client reconnects with the stream's `Last-Event-ID`.
//
// Nothing in the server makes a run without starting an agent yet, so the test puts one straight into the server's
// database (a second connection to its SQLite file) and writes its servers' settings in its folder as a launch does:
// a test-only path that stays out of the server. The board's own tools come with 3.2, so the call is to a tool the
// server doesn't have, which goes through the whole path and comes back as the tool's error.

const RUN = "e2e-run-1"
const AT = "2026-11-12T00:00:00.000Z"

/** The run's secret, as the plan defines it: HMAC-SHA256(board token, "mcp:" + run id) in hex. */
const secretOf = (token: string, run: string) => createHmac("sha256", token).update(`mcp:${run}`).digest("hex")

/** The events of a finished event stream: each block's `data` and `id`. */
const events = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n")
      const field = (name: string) =>
        lines
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim()
      return { id: field("id"), data: field("data") ?? "" }
    })

const headers = (secret: string, more: Readonly<Record<string, string>> = {}) => ({ authorization: `Bearer ${secret}`, ...more })

const Answer = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Finite,
    result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })), isError: Schema.optional(Schema.Boolean) }),
  }),
)

describe("MCP over HTTP, on a whole server", () => {
  it.live("a run's tools/call is answered as an event stream, once, and again on reconnecting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token, dataDir } = yield* startServer(["--no-agents"])
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('e2e', 'e2e', ${AT})`
        yield* sql`INSERT INTO tasks (id, profile_id, title, status, running, last_activity_at, created_at, updated_at)
          VALUES ('e2e-task', 'e2e', 'A task', 'in_progress', 1, ${AT}, ${AT}, ${AT})`
        yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES (${RUN}, 'e2e-task', 'prompt', 'running', ${AT})`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds" })))
      yield* fs.makeDirectory(`${dataDir}/runs/${RUN}`, { recursive: true })
      yield* fs.writeFileString(`${dataDir}/runs/${RUN}/mcp-run.json`, '{"cwd":"/tmp","github_account":null,"review":false,"in_process":false,"desktop":false}')

      const client = yield* HttpClient.HttpClient
      const url = `http://127.0.0.1:${port}/api/mcp/${RUN}/huntaway`
      const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }

      // The board token, or another run's secret, isn't this run's.
      for (const secret of [token, secretOf(token, "another-run")]) {
        const refused = yield* client.execute(
          HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers(secret)), HttpClientRequest.bodyJsonUnsafe(call)),
        )
        assert.strictEqual(refused.status, 401)
      }

      const secret = secretOf(token, RUN)
      const response = yield* client.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers(secret, { accept: "application/json, text/event-stream" })),
          HttpClientRequest.bodyJsonUnsafe(call),
        ),
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      const [prime, last] = events(yield* response.text)
      assert.isTrue(prime?.id !== undefined && prime.data === "", "a priming event first")
      const answer = yield* Schema.decodeEffect(Answer)(last?.data ?? "")
      assert.deepStrictEqual([answer.id, answer.result.content[0]?.text, answer.result.isError], [7, "Error: unknown tool no_such_tool", true])

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly run_id: string; readonly status: string; readonly error: string | null }>`SELECT run_id, status, error FROM mcp_calls`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds", readonly: true })))
      assert.deepStrictEqual(rows, [{ run_id: RUN, status: "done", error: "unknown tool no_such_tool" }])

      // The client's stream broke: it reconnects with the stream's id and is given the answer recorded.
      const again = yield* client.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(secret, { accept: "text/event-stream", "last-event-id": prime?.id ?? "" }))),
      )
      const [primeAgain, lastAgain] = events(yield* again.text)
      assert.strictEqual(primeAgain?.id, prime?.id)
      assert.deepStrictEqual(yield* Schema.decodeEffect(Answer)(lastAgain?.data ?? ""), answer)
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )
})
