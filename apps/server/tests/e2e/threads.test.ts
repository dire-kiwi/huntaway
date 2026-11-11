import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { TaskId, ThreadSnapshot } from "@huntaway/contracts"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// A task's thread over the websocket, on a real server: a task with no thread yet is an empty snapshot, its page is
// empty, and a task that isn't there is NotFound. Watching it while the board writes to it waits for the first RPC
// that writes a thread (`tasks.send`, plan task 2.5); the service and in-process RPC tests have the live part.

// A message's `type` does not narrow it (an event of a newer host's type is a message too): its schema does.
const isSnapshot = Schema.is(ThreadSnapshot)

describe("threads.watch over a websocket", () => {
  it.live("a new task's thread is an empty snapshot; a missing task's is NotFound", () =>
    Effect.gen(function* () {
      const { port, token } = yield* startServer()
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const profile = yield* http["profiles.create"]({ profile: { name: "me" } })
      const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Talk" } })

      const { first, page, missing } = yield* Effect.gen(function* () {
        const socket = yield* RpcClient.make(CliRpcs)
        const [message] = yield* socket["threads.watch"]({ task_id: task.id, limit: 50 }).pipe(Stream.take(1), Stream.runCollect)
        return {
          first: message,
          page: yield* socket["threads.page"]({ task_id: task.id, before: 0, limit: 50 }),
          missing: yield* Effect.flip(Stream.runCollect(socket["threads.watch"]({ task_id: TaskId.make("gone"), limit: 50 }))),
        }
      }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

      assert.deepStrictEqual(
        isSnapshot(first) ? [first.thread.id, first.thread.status, first.thread.title, first.items, first.requests, first.seq, first.preview] : null,
        [task.id, "idle", "Talk", [], [], 0, null],
      )
      assert.deepStrictEqual([page.items, page.start, page.seq], [[], 0, 0])
      assert.deepStrictEqual(missing._tag === "NotFound" ? [missing.what, missing.id] : missing._tag, ["task", "gone"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
