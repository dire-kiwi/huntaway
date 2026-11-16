import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { PluginId } from "@huntaway/contracts"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// HE-42: the board's documents are the docs plugin's (`@dire-kiwi/docs-huntaway`, plugins/installed.ts), on a whole
// server as it's built: a run publishes a document through the plugin's `docs` server, as its agent would, and the
// plugin's page at the path the link it was given names shows it. The run is put straight into the server's database,
// as mcp.test.ts does.

const RUN = "e2e-docs-run"
const AT = "2026-11-16T00:00:00.000Z"

/** The run's secret: HMAC-SHA256(board token, "mcp:" + run id) in hex. */
const secretOf = (token: string, run: string) => createHmac("sha256", token).update(`mcp:${run}`).digest("hex")

/** The last event's data of a finished event stream: the call's answer. */
const lastData = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":"))
    .map(
      (block) =>
        block
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim() ?? "",
    )
    .findLast((data) => data !== "") ?? ""

const Answer = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })), isError: Schema.optional(Schema.Boolean) }),
  }),
)
const Published = Schema.fromJsonString(Schema.Struct({ slug: Schema.String, version: Schema.Finite, url: Schema.String }))

describe("the docs plugin, on a whole server", () => {
  it.live("a run publishes a document through the docs server, and the plugin's page at its link shows it", () =>
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
      yield* fs.writeFileString(`${dataDir}/runs/${RUN}/mcp-run.json`, '{"cwd":"/tmp","github_account":null,"review":false,"in_process":true,"desktop":false}')

      const client = yield* HttpClient.HttpClient
      const call = (name: string, args: unknown) =>
        client
          .execute(
            HttpClientRequest.post(`http://127.0.0.1:${port}/api/mcp/${RUN}/docs`).pipe(
              HttpClientRequest.setHeaders({ authorization: `Bearer ${secretOf(token, RUN)}`, accept: "application/json, text/event-stream" }),
              HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
            ),
          )
          .pipe(
            Effect.flatMap((r) => r.text),
            Effect.flatMap((text) => Schema.decodeEffect(Answer)(lastData(text))),
          )

      const answer = yield* call("publish_document", { title: "Rollout plan", pages: [{ path: "index", content: "# Rollout plan\n\nShip it.\n" }] })
      assert.notStrictEqual(answer.result.isError, true, answer.result.content[0]?.text)
      const published = yield* Schema.decodeEffect(Published)(answer.result.content[0]?.text ?? "")
      assert.deepStrictEqual([published.slug, published.version], ["rollout-plan", 1])
      // The link agents are given is the board's own `/docs/<profile id>/d/<slug>/`, as the built-in documents' was.
      const path = new URL(published.url).pathname
      assert.strictEqual(path, "/docs/e2e/d/rollout-plan/")

      const rpc = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const page = yield* rpc["plugins.page"]({ plugin: PluginId.make("docs"), slot: "page", path: path.slice("/docs/".length), query: {}, task_id: null })
      assert.strictEqual(page.type, "html")
      assert.include(page.type === "html" ? page.html : "", "Ship it.")
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )
})
