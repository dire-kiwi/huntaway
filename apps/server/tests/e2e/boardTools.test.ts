import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { startServer } from "./launch.ts"

// The board's own tools on a whole server (docs/plan/07-agents.md, Board tools; plan task 3.2): a run's `tools/list`
// and `tools/call`s of `create_task` (not started) and `list_tasks` over `/api/mcp/<run>/huntaway`, as a compaction or
// a Codex run reaches them. The run is put straight into the server's database, as in mcp.test.ts.

const RUN = "e2e-run-tools"
const AT = "2026-11-12T00:00:00.000Z"

const secretOf = (token: string, run: string) => createHmac("sha256", token).update(`mcp:${run}`).digest("hex")

const Response = Schema.Struct({
  id: Schema.Finite,
  result: Schema.Struct({
    content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))),
    tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    isError: Schema.optional(Schema.Boolean),
  }),
})
const Answer = Schema.fromJsonString(Response)
const Summary = Schema.fromJsonString(Schema.Struct({ key: Schema.String, title: Schema.String, status: Schema.String, profile: Schema.String }))
const Summaries = Schema.fromJsonString(Schema.Array(Schema.Struct({ key: Schema.String, title: Schema.String })))

/** The last event's data of an event stream, or the body as it is for a JSON answer. */
const lastData = (text: string) => {
  const data = text.split("\n").findLast((l) => l.startsWith("data:") && l.trim() !== "data:")
  return data === undefined ? text : data.slice("data:".length).trim()
}

/** A tool's answer's text, which is not an error. */
const textOf = (answer: typeof Response.Type) => {
  assert.notStrictEqual(answer.result.isError, true, answer.result.content?.[0]?.text)
  return answer.result.content?.[0]?.text ?? ""
}

describe("the board's tools on a whole server", () => {
  it.live("a run lists the board's tools, creates a task without starting it, and lists it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token, dataDir } = yield* startServer(["--no-agents"])
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('e2e', 'e2e', ${AT})`
        yield* sql`INSERT INTO tasks (id, profile_id, title, status, task_type, number, running, last_activity_at, created_at, updated_at)
          VALUES ('e2e-task', 'e2e', 'The caller', 'in_progress', 'scratch', 1, 1, ${AT}, ${AT}, ${AT})`
        yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES (${RUN}, 'e2e-task', 'prompt', 'running', ${AT})`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds" })))
      yield* fs.makeDirectory(`${dataDir}/runs/${RUN}`, { recursive: true })
      yield* fs.writeFileString(`${dataDir}/runs/${RUN}/mcp-run.json`, '{"cwd":"/tmp","github_account":null,"review":false,"in_process":false,"desktop":false}')

      const client = yield* HttpClient.HttpClient
      const url = `http://127.0.0.1:${port}/api/mcp/${RUN}/huntaway`
      const headers = { authorization: `Bearer ${secretOf(token, RUN)}`, accept: "application/json, text/event-stream" }
      const rpc = (id: number, method: string, params: unknown) =>
        client
          .execute(
            HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers), HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, method, params })),
          )
          .pipe(
            Effect.flatMap((r) => r.text),
            Effect.flatMap((text) => Schema.decodeEffect(Answer)(lastData(text))),
          )
      const listed = yield* rpc(1, "tools/list", {})
      const names = (listed.result.tools ?? []).map((t) => t.name)
      assert.deepStrictEqual(names.slice(0, 4), ["request_user_input", "finish_work", "list_projects", "list_tasks"])

      const created = yield* Schema.decodeEffect(Summary)(
        textOf(yield* rpc(2, "tools/call", { name: "create_task", arguments: { title: "From an agent", type: "scratch", start: false } })),
      )
      assert.deepStrictEqual([created.key, created.title, created.status, created.profile], ["S-2", "From an agent", "todo", "e2e"])

      const all = yield* Schema.decodeEffect(Summaries)(textOf(yield* rpc(3, "tools/call", { name: "list_tasks", arguments: {} })))
      assert.deepStrictEqual(
        all.map((t) => [t.key, t.title]).toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
        [
          ["S-1", "The caller"],
          ["S-2", "From an agent"],
        ],
      )
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )
})
