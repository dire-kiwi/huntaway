import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Fiber, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { applyEvent, ItemAdded, RequestId, RequestOpened, TaskChanged, ThreadEvent, ThreadSnapshot } from "@huntaway/contracts"
import type { Snapshot } from "@huntaway/contracts"
import { ensureShim, FAKE_CODEX } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// The same task running with Codex as its agent (M5), on a whole server: the fake `codex app-server`
// (packages/testing/bin/fake-codex) under `huntaway codex-run` (the adapter, 5.1) under the checkout's real ia-shim. A
// message starts a run on a Codex config; Codex asks to run a command (a permission prompt the user allows, answered on
// the run's input as Codex takes it) and calls one of the board's tools as a dynamic tool (answered through the board's
// dispatch); its reply and the turn's result come into the thread; with nothing more to say the board closes the run's
// input, the adapter ends, and the task goes to In review. The run's folder has the `codex.json` the adapter read.

const isSnapshot = Schema.is(ThreadSnapshot)
const isEvent = Schema.is(ThreadEvent)
const isAdded = Schema.is(ItemAdded)
const isOpened = Schema.is(RequestOpened)
const isTaskEvent = Schema.is(TaskChanged)

const shim = ensureShim()

describe.skipIf(shim === null)("a Codex run on a whole server", () => {
  it.live("a message starts a Codex run; its approval and board call are answered; its reply and result arrive; it ends in In review", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token, dataDir } = yield* startServer(["--codex-bin", FAKE_CODEX])
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const home = `${dataDir}/codex-home`
      yield* fs.makeDirectory(home, { recursive: true })
      const config = yield* http["configs.create"]({ config: { name: "Codex", agent: "codex", config_dir: home } })
      const profile = yield* http["profiles.create"]({ profile: { name: "me", claude_config_ids: [config.id] } })
      const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Talk", claude_config_id: config.id } })

      const seen = yield* Effect.gen(function* () {
        const socket = yield* RpcClient.make(CliRpcs)
        // The thread, folded as a client folds it, until the turn's result; a permission Codex asks for, the user allows.
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
      const kinds = items.map((i) => (i.type === "tool_call" ? `${i.type} ${i.name}: ${i.status}` : i.type))
      assert.strictEqual(kinds.at(0), "user_message")
      assert.include(kinds, "tool_call Bash: completed")
      assert.include(kinds, "tool_call list_projects: completed")
      assert.strictEqual(kinds.at(-1), "turn_result")
      const reply = items.find((i) => i.type === "assistant_message")
      const text = reply?.type === "assistant_message" ? reply.text : ""
      assert.include(text, "permission Bash: accept")
      assert.include(text, "board list_projects:")
      assert.deepStrictEqual(
        seen?.requests.map((r) => [r.type, r.resolution?.outcome]),
        [["permission", "allow"]],
      )

      // The run ended, and the task went to In review, its session the Codex thread's.
      const after = yield* http["tasks.get"]({ id: task.id })
      assert.deepStrictEqual([after.running, after.status], [false, "in_review"])
      assert.isTrue(after.session_id?.startsWith("thread-") === true, after.session_id ?? "")
      const run = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly id: string; readonly board_tools: number; readonly saw_result: number; readonly status: string }>`
          SELECT id, board_tools, saw_result, status FROM runs WHERE task_id = ${task.id}`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds", readonly: true })))
      assert.deepStrictEqual(
        run.map((r) => [r.board_tools, r.saw_result, r.status]),
        [[1, 1, "exited"]],
      )
      const spec = yield* fs.readFileString(`${dataDir}/runs/${run[0]?.id ?? ""}/codex.json`)
      assert.include(spec, '"requests_on_output": true')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
