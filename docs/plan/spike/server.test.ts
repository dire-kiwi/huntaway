import { assert, describe, it, layer } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { RpcMiddleware, RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Auth, BoardRpcs, Session, type TaskId } from "./contracts.ts"
import { Events, Handlers, migrations, Tasks } from "./server.ts"

// A fresh in-memory database, the real services, and the middleware replaced: no HTTP, no socket.
const TestLive = Handlers.pipe(
  Layer.provideMerge(Tasks.layer),
  Layer.provideMerge(Events.layer),
  Layer.provide(SqliteMigrator.layer({ loader: migrations }).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))),
  Layer.merge(Layer.succeed(Auth, Auth.of((effect) => Effect.provideService(effect, Session, { device: "test" })))),
  Layer.merge(RpcMiddleware.layerClient(Auth, ({ next, request }) => next(request)))
)

layer(TestLive)("board rpcs", (it) => {
  it.effect("create, move and observe a task through the typed client", () =>
    Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(BoardRpcs)
      const seen = yield* client["board.subscribe"]({}).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const task = yield* client["tasks.create"]({ title: "a" })
      const done = yield* client["tasks.setStatus"]({ id: task.id, status: "done" })
      assert.strictEqual(done.status, "done")
      assert.deepStrictEqual((yield* Fiber.join(seen)).map((e) => e.seq), [1, 2])
    }))

  it.effect("a missing task is a typed error, not an exception", () =>
    Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(BoardRpcs)
      const error = yield* client["tasks.get"]({ id: "nope" as TaskId }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "TaskNotFound")
    }))
})

describe("time", () => {
  it.effect("twenty minutes pass at once on the test clock", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.sleep("20 minutes").pipe(Effect.as("woke"), Effect.forkChild)
      yield* TestClock.adjust("20 minutes")
      assert.strictEqual(yield* Fiber.join(fiber), "woke")
    }))
})
