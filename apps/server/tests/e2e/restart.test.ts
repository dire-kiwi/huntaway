import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { ItemAdded, TaskChanged, ThreadSnapshot } from "@huntaway/contracts"
import type { Item, Task, TaskId } from "@huntaway/contracts"
import { ensureShim, FAKE_CLAUDE } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { e2eDataDir, socketRpcClientLayer, startServer } from "./launch.ts"

// Restarts under a running agent (plan task 2.6's whole-server tests), with the fake `claude` under the real ia-shim:
// the server stops while the agent works, and the next server on the same data folder adopts its run, follows its
// output from the saved offset, and ends it in its column. A power cut: the database goes back to a copy taken while
// the agent worked (its last commits lost, the offset with them), and the next server applies the run's output again
// from there, adding nothing twice. The data folder's agents are killed when the test ends (`e2eDataDir`).

const isSnapshot = Schema.is(ThreadSnapshot)
const isAdded = Schema.is(ItemAdded)
const isTaskEvent = Schema.is(TaskChanged)

const shim = ensureShim()
const ARGS = ["--claude-bin", FAKE_CLAUDE]

/** A server on `dataDir` with the fake agent, which sleeps `sleep` seconds before it answers. */
const server = (dataDir: string, sleep: string) => startServer(ARGS, { HUNTAWAY_FAKE_CLAUDE_SLEEP: sleep }, dataDir)

const client = (port: number, token: string) => RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))

/** Sends `text` to a new task, and waits until a steered message is written to its run's input (it has started). */
const startRun = (port: number, token: string) =>
  Effect.gen(function* () {
    const http = yield* client(port, token)
    const profile = yield* http["profiles.create"]({ profile: { name: "me" } })
    const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Talk" } })
    yield* Effect.gen(function* () {
      const socket = yield* RpcClient.make(CliRpcs)
      const written = yield* socket["board.watch"]({}).pipe(
        Stream.filter((m) => isTaskEvent(m) && m.task.id === task.id && m.task.steering.some((s) => s.written)),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* http["tasks.send"]({ id: task.id, text: "hello" })
      yield* http["tasks.send"]({ id: task.id, text: "and this too" })
      yield* Fiber.join(written)
    }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))
    return task.id
  })

/** The thread's items until its turn result, and the task once it has left In progress for its column. */
const untilEnded = (port: number, token: string, id: TaskId) =>
  Effect.gen(function* () {
    const socket = yield* RpcClient.make(CliRpcs)
    const column = yield* socket["board.watch"]({}).pipe(
      Stream.flatMap((m) => Stream.fromIterable(isTaskEvent(m) && m.task.id === id && !m.task.running ? [m.task] : [])),
      Stream.take(1),
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    )
    const items = yield* socket["threads.watch"]({ task_id: id, limit: 50 }).pipe(
      Stream.flatMap((m) => Stream.fromIterable(isSnapshot(m) ? m.items : isAdded(m) ? [m.item] : [])),
      Stream.takeUntil((item: Item) => item.type === "turn_result"),
      Stream.runCollect,
    )
    const http = yield* client(port, token)
    const now = yield* http["tasks.get"]({ id })
    const task: Task = now.running ? Option.getOrElse(yield* Fiber.join(column), () => now) : now
    return { items: [...items], task }
  }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

const summary = (items: ReadonlyArray<Item>) =>
  items.map((i) => (i.type === "user_message" ? `user${i.steered === true ? " (steered)" : ""}: ${i.text}` : i.type))

const EXPECTED = ["user: hello", "user (steered): and this too", "assistant_message", "turn_result"]

describe.skipIf(shim === null)("restarts under a running agent", () => {
  it.live("the next server adopts the run, follows it on, and ends it in its column", () =>
    Effect.gen(function* () {
      const dataDir = yield* e2eDataDir
      const { id, token } = yield* Effect.gen(function* () {
        const first = yield* server(dataDir, "4")
        return { id: yield* startRun(first.port, first.token), token: first.token }
      }).pipe(Effect.scoped)
      // The first server has stopped (SIGTERM); the agent goes on under its shim.
      const second = yield* server(dataDir, "4")
      assert.strictEqual(second.token, token)
      const { items, task } = yield* untilEnded(second.port, second.token, id)
      assert.deepStrictEqual(summary(items), EXPECTED)
      assert.deepStrictEqual([task.running, task.status, task.steering, task.queued_message], [false, "in_review", [], null])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("after a power cut, the run's output is applied again from the offset the database kept, adding nothing twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* e2eDataDir
      const copy = `${dataDir}/board-before.db`
      const id = yield* Effect.gen(function* () {
        const first = yield* server(dataDir, "2")
        const started = yield* startRun(first.port, first.token)
        // What the disk had when the power went: the run started, nothing of its output applied yet.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`VACUUM INTO ${copy}`
        }).pipe(Effect.provide(SqliteClient.layer({ filename: `${dataDir}/board.db`, busyTimeout: "5 seconds" })))
        // The server went on applying it, then went down.
        const { items } = yield* untilEnded(first.port, first.token, started)
        assert.deepStrictEqual(summary(items), EXPECTED)
        return started
      }).pipe(Effect.scoped)
      for (const file of ["board.db-wal", "board.db-shm"]) yield* fs.remove(`${dataDir}/${file}`, { force: true })
      yield* fs.rename(copy, `${dataDir}/board.db`)
      const second = yield* server(dataDir, "2")
      const { items, task } = yield* untilEnded(second.port, second.token, id)
      assert.deepStrictEqual(summary(items), EXPECTED)
      assert.deepStrictEqual([task.running, task.status], [false, "in_review"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
