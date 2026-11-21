import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Fiber, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { applyEvent, ItemAdded, RequestId, RequestOpened, TaskChanged, ThreadEvent, ThreadSnapshot } from "@huntaway/contracts"
import type { Snapshot } from "@huntaway/contracts"
import { ensureShim, FAKE_ACP } from "@huntaway/testing"
import { specFromJson } from "../../src/agents/acp/spec.ts"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// A task running with an ACP agent (HE-69), on a whole server: fake-acp (packages/testing/bin/fake-acp, an ACP agent
// with fake-codex's markers) under `huntaway acp-run` (the adapter) under the checkout's real ia-shim. A message starts a
// run on an ACP config whose command line is fake-acp; the agent asks to run a command (a permission prompt the user
// allows, answered on the run's input as a Codex approval is) and calls one of the board's tools on the board's MCP
// server (the `huntaway` server of its `session/new`, reached through `huntaway mcp-stdio`); its reply and the turn's
// result come into the thread; the board closes the run's input, the adapter ends, and the task goes to In review. The
// run's folder has the `acp.json` the adapter read.

const isSnapshot = Schema.is(ThreadSnapshot)
const isEvent = Schema.is(ThreadEvent)
const isAdded = Schema.is(ItemAdded)
const isOpened = Schema.is(RequestOpened)
const isTaskEvent = Schema.is(TaskChanged)
const Json = Schema.fromJsonString(Schema.Unknown)

const shim = ensureShim()

describe.skipIf(shim === null)("an ACP agent's run on a whole server", () => {
  it.live("a message starts an ACP run; its permission and board call are answered; its reply and result arrive; it ends in In review", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token, dataDir } = yield* startServer()
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const home = `${dataDir}/gemini-home`
      yield* fs.makeDirectory(home, { recursive: true })
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-e2e-repo-" })
      const config = yield* http["configs.create"]({ config: { name: "Gemini", agent: "acp", config_dir: home, command: FAKE_ACP } })
      assert.deepStrictEqual([config.agent, config.command], ["acp", FAKE_ACP])
      // Its models, as the agent lists them (`acp-run --list-models`): fake-acp's, the first current.
      const models = yield* http["configs.models"]({ id: config.id })
      assert.deepStrictEqual(
        models.map((m) => [m.id, m.is_default, m.efforts]),
        [
          ["fake-flash", true, ["low", "high"]],
          ["fake-pro", false, ["low", "high"]],
        ],
      )
      const profile = yield* http["profiles.create"]({ profile: { name: "me", claude_config_ids: [config.id] } })
      // A project for the board call to name.
      yield* http["projects.create"]({ project: { profile_id: profile.id, repo_path: repo, name: "Web" } })
      const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Talk", claude_config_id: config.id } })

      const seen = yield* Effect.gen(function* () {
        const socket = yield* RpcClient.make(CliRpcs)
        // The thread, folded as a client folds it, until the turn's result; a permission the agent asks for, the user allows.
        const watched = yield* socket["threads.watch"]({ task_id: task.id, limit: 50 }).pipe(
          Stream.mapAccum(
            (): Snapshot | null => null,
            (state, m) => {
              const next = isSnapshot(m)
                ? { thread: m.thread, items: m.items, requests: m.requests, seq: m.seq }
                : state !== null && isEvent(m)
                  ? applyEvent(state, m)
                  : state
              return [next, [{ state: next, message: m }]]
            },
          ),
          Stream.tap(({ message }) =>
            isOpened(message) && message.request.type === "permission" && message.request.resolution === undefined
              ? http["permissions.answer"]({ id: RequestId.make(message.request.id), answer: { decision: "allow" } }).pipe(Effect.ignore)
              : Effect.void,
          ),
          Stream.takeUntil(({ message }) => isAdded(message) && message.item.type === "turn_result"),
          Stream.runLast,
          Effect.forkChild({ startImmediately: true }),
        )
        // The board's events, until the task has stopped running and gone to In review: its run ended.
        const ended = yield* socket["board.watch"]({}).pipe(
          Stream.filter((m) => isTaskEvent(m) && m.task.id === task.id && !m.task.running && m.task.status === "in_review"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        )
        const started = yield* http["tasks.send"]({ id: task.id, text: "fake-ask-permission\nfake-board-call list_projects {}" })
        assert.isTrue(started.running)
        const last = yield* Fiber.join(watched)
        yield* Fiber.join(ended)
        return last._tag === "Some" ? last.value.state : null
      }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

      const items = seen?.items ?? []
      assert.strictEqual(items.at(0)?.type, "user_message")
      assert.strictEqual(items.at(-1)?.type, "turn_result")
      // The command it was allowed, with its output.
      const bash = items.find((i) => i.type === "tool_call" && i.name === "Bash")
      assert.deepStrictEqual(bash?.type === "tool_call" ? [bash.kind, bash.status] : null, ["shell", "completed"])
      assert.notStrictEqual(bash?.type === "tool_call" ? (bash.result?.content ?? "") : "", "")
      // The board's tool, called on its MCP server: the project is in what it returned.
      const board = items.find((i) => i.type === "tool_call" && i.name === "list_projects")
      assert.deepStrictEqual(board?.type === "tool_call" ? [board.kind, board.server, board.status] : null, ["mcp", "huntaway", "completed"])
      assert.include(board?.type === "tool_call" ? (board.result?.content ?? "") : "", "Web")
      // Its reply.
      const reply = items.find((i) => i.type === "assistant_message")
      assert.notStrictEqual(reply?.type === "assistant_message" ? reply.text : "", "")
      assert.deepStrictEqual(
        seen?.requests.map((r) => [r.type, r.resolution?.outcome]),
        [["permission", "allow"]],
      )
      // The prompt is recorded as an ACP agent's (its card says "The agent", not "Codex"), with what answering it takes.
      assert.deepStrictEqual(
        seen?.requests.map((r) => [r.metadata?.["agent"], r.metadata?.["codex"] !== undefined]),
        [["acp", true]],
      )

      // The run ended, and the task went to In review, its session the agent's.
      const after = yield* http["tasks.get"]({ id: task.id })
      assert.deepStrictEqual([after.running, after.status], [false, "in_review"])
      assert.isNotNull(after.session_id)
      const run = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly id: string; readonly saw_result: number; readonly status: string }>`
          SELECT id, saw_result, status FROM runs WHERE task_id = ${task.id}`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds", readonly: true })))
      assert.deepStrictEqual(
        run.map((r) => [r.saw_result, r.status]),
        [[1, "exited"]],
      )
      // What the adapter read: fake-acp as the agent, and the board's own server over HTTP with the run's secret.
      const runDir = `${dataDir}/runs/${run[0]?.id ?? ""}`
      const spec = specFromJson(yield* Schema.decodeEffect(Json)(yield* fs.readFileString(`${runDir}/acp.json`)))
      assert.deepStrictEqual([spec?.program, spec?.args, spec?.session_id, spec?.input], [FAKE_ACP, [], null, true])
      const own = spec?.mcp_servers.find((s) => s.name === "huntaway")
      assert.isTrue(own !== undefined && "type" in own && own.type === "http" && own.url.endsWith("/huntaway"))
      const bearer = own !== undefined && "headers" in own ? own.headers.find((h) => h.name === "Authorization")?.value : undefined
      assert.isTrue(bearer?.startsWith("Bearer ") === true && bearer.length > "Bearer ".length, bearer)
      assert.isFalse(yield* fs.exists(`${runDir}/codex.json`))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("an agent that isn't signed in has no models to list, and says how to sign in", () =>
    Effect.gen(function* () {
      const { port, token } = yield* startServer([], { FAKE_ACP_SIGNED_OUT: "1" })
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const config = yield* http["configs.create"]({ config: { name: "Gemini", agent: "acp", command: FAKE_ACP } })
      const e = yield* Effect.flip(http["configs.models"]({ id: config.id }))
      assert.strictEqual(e._tag, "Unavailable")
      assert.include(e._tag === "Unavailable" ? e.reason : "", "sign in by running it once by itself")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
