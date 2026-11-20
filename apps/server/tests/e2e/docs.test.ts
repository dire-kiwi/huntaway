import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { PluginId } from "@huntaway/contracts"
import { makeLegacyBoard } from "@huntaway/testing"
import { importLegacy } from "../../src/cli/importLegacy/run.ts"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { seedParents } from "../importLegacy/importOld.ts"
import { e2eDataDir, startServer } from "./launch.ts"

// HE-42: the board's documents are the docs plugin's (`@dire-kiwi/docs-huntaway`, plugins/installed.ts), on a whole
// server as it's built: a run publishes a document through the plugin's `docs` server, as its agent would, and the
// plugin's page at the path the link it was given names shows it. The run is put straight into the server's database,
// as mcp.test.ts does. And a switch over a board this build has run (`import-legacy --replace`, switch-board.sh) brings
// the old board's documents to the plugin, which copied the replaced board's on its first start.

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
const UploadUrl = Schema.fromJsonString(Schema.Struct({ upload_url: Schema.String }))
const Uploaded = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))

/** A 1×1 PNG, for an image sent to an upload URL. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64")

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
      // The link agents are given is the board's own `/docs/<profile id>/d/<slug>/`, as the built-in documents' was, on
      // the port the server listens on (`--port 0` here; HE-63).
      const path = new URL(published.url).pathname
      assert.strictEqual(path, "/docs/e2e/d/rollout-plan/")
      assert.strictEqual(new URL(published.url).port, String(port))

      const rpc = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const page = yield* rpc["plugins.page"]({ plugin: PluginId.make("docs"), slot: "page", path: path.slice("/docs/".length), query: {}, task_id: null })
      assert.strictEqual(page.type, "html")
      assert.include(page.type === "html" ? page.html : "", "Ship it.")

      // HE-63: an image file sent over HTTP to the URL `create_upload_url` gives (the plugin's public route, no board
      // token, as an agent's `curl` sends it), then named by its id in a publish, shows in the page.
      const asked = yield* call("create_upload_url", {})
      const { upload_url } = yield* Schema.decodeEffect(UploadUrl)(asked.result.content[0]?.text ?? "")
      assert.strictEqual(new URL(upload_url).port, String(port))
      const sent = yield* client.execute(HttpClientRequest.post(upload_url).pipe(HttpClientRequest.bodyUint8Array(PNG, "image/png")))
      const sentText = yield* sent.text
      assert.strictEqual(sent.status, 200, sentText)
      const uploaded = yield* Schema.decodeEffect(Uploaded)(sentText)
      const withImage = yield* call("publish_document", {
        title: "Chart",
        pages: [{ path: "index", content: "# Chart\n\n![A dot](images/dot.png)\n" }],
        images: [{ name: "images/dot.png", upload: uploaded.id }],
      })
      assert.notStrictEqual(withImage.result.isError, true, withImage.result.content[0]?.text)
      const chart = yield* rpc["plugins.page"]({ plugin: PluginId.make("docs"), slot: "page", path: "e2e/d/chart/", query: {}, task_id: null })
      assert.include(chart.type === "html" ? chart.html : "", "data:image/avif")
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )

  it.live("an import that replaces a board the plugin has run on shows the imported documents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* e2eDataDir
      // This build ran here first: the plugin made its database and copied the (empty) board's documents, once.
      yield* Effect.scoped(startServer(["--no-agents"], {}, dataDir))
      assert.isTrue(yield* fs.exists(`${dataDir}/plugins/docs/plugin.db`))

      const old = `${yield* fs.makeTempDirectoryScoped()}/old`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const board = yield* makeLegacyBoard(old)
          yield* seedParents(board)
          yield* board.insert("docs", { id: "d1", profile_id: "p1", slug: "plan", title: "The plan", created_at: AT, updated_at: AT, folder: "" })
          yield* board.insert("doc_versions", { id: "v1", doc_id: "d1", number: 1, message: null, task_id: "t1", run_id: null, created_at: AT })
          yield* board.insert("doc_pages", {
            version_id: "v1",
            path: "index",
            title: "The plan",
            format: "md",
            source: "# The plan\n\nImported.\n",
            position: 0,
          })
        }),
      )
      const imported = yield* importLegacy({ from: old, dataDir, check: false, force: false, rehearsal: false, database: Option.none(), replace: true })
      assert.isNotNull(imported.replaced)
      // The replaced board's plugin data went aside with it.
      assert.isTrue(yield* fs.exists(`${imported.replaced ?? ""}/plugins/docs/plugin.db`))

      const { port, token } = yield* startServer(["--no-agents"], {}, dataDir)
      const rpc = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const page = yield* rpc["plugins.page"]({ plugin: PluginId.make("docs"), slot: "page", path: "p1/d/plan/", query: {}, task_id: null })
      assert.strictEqual(page.type, "html")
      assert.include(page.type === "html" ? page.html : "", "Imported.")
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )
})
