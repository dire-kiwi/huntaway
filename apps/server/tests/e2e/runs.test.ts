import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { ItemAdded, TaskChanged, ThreadSnapshot } from "@huntaway/contracts"
import type { Item } from "@huntaway/contracts"
import { ensureShim, FAKE_CLAUDE } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// A Claude run on a whole server, with the fake `claude` (packages/testing/bin/fake-claude) under the checkout's real
// ia-shim: a message starts a run, a second one sent while the agent works is steered into its turn, and a stop
// interrupts it. The thread is watched over the websocket until the agent's reply and the turn's result arrive. The
// fake agent sleeps a while before it answers, so that the second message and the stop come during its turn. The end
// of the run (the task's column) is plan task 2.6's; here the run's row says it was stopped.

const isSnapshot = Schema.is(ThreadSnapshot)
const isAdded = Schema.is(ItemAdded)
const isTaskEvent = Schema.is(TaskChanged)

const shim = ensureShim()

describe.skipIf(shim === null)("a Claude run on a whole server", () => {
  it.live("a message starts a run; one sent meanwhile is steered in; the reply and the turn's result arrive; a stop interrupts it", () =>
    Effect.gen(function* () {
      const { port, token, dataDir } = yield* startServer(["--claude-bin", FAKE_CLAUDE], { HUNTAWAY_FAKE_CLAUDE_SLEEP: "3" })
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const profile = yield* http["profiles.create"]({ profile: { name: "me" } })
      const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Talk" } })

      const seen = yield* Effect.gen(function* () {
        const socket = yield* RpcClient.make(CliRpcs)
        // Everything the thread gets, until the turn's result.
        const watched = yield* socket["threads.watch"]({ task_id: task.id, limit: 50 }).pipe(
          Stream.flatMap((m) => Stream.fromIterable(isSnapshot(m) ? m.items : isAdded(m) ? [m.item] : [])),
          Stream.takeUntil((item: Item) => item.type === "turn_result"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        )
        // The board's events, until the steered message has been written to the agent's input: its run has started.
        const written = yield* socket["board.watch"]({}).pipe(
          Stream.filter((m) => isTaskEvent(m) && m.task.id === task.id && m.task.steering.some((s) => s.written)),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        )
        const started = yield* http["tasks.send"]({ id: task.id, text: "hello" })
        assert.isTrue(started.running)
        const steered = yield* http["tasks.send"]({ id: task.id, text: "and this too" })
        assert.deepStrictEqual(
          steered.steering.map((s) => s.text),
          ["and this too"],
        )
        assert.strictEqual(steered.queued_message, null)
        yield* Fiber.join(written)
        assert.deepStrictEqual(yield* http["tasks.stop"]({ id: task.id }), { stopped: true })
        return yield* Fiber.join(watched)
      }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

      const items = [...seen]
      assert.deepStrictEqual(
        items.map((i) => (i.type === "user_message" ? `user${i.steered === true ? " (steered)" : ""}: ${i.text}` : i.type)),
        ["user: hello", "user (steered): and this too", "assistant_message", "turn_result"],
      )
      // The fake agent answers what it was sent: the task's first prompt, then the steered message.
      const reply = items.find((i) => i.type === "assistant_message")
      const text = reply?.type === "assistant_message" ? reply.text : ""
      assert.isTrue(text.startsWith("Fake reply to: # S-1: Talk") && text.endsWith("hello (and to: and this too)"), text)
      const after = yield* http["tasks.get"]({ id: task.id })
      assert.deepStrictEqual([after.steering, after.queued_message, after.session_id !== null], [[], null, true])

      // The run's row: stopped, its turn's end recorded with it.
      const run = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          readonly stop: string
          readonly saw_result: number
          readonly kind: string
        }>`SELECT stop, saw_result, kind FROM runs WHERE task_id = ${task.id}`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds", readonly: true })))
      assert.deepStrictEqual(run, [{ stop: "interrupted", saw_result: 1, kind: "prompt" }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
