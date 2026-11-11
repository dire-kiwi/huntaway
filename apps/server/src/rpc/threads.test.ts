import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { Headers } from "effect/http"
import { RpcMiddleware, RpcTest } from "effect/rpc"
import { Auth, ItemAdded, ProfileId, TaskId, ThreadRpcs, ThreadSnapshot, Timestamp } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { AuthLive } from "./AuthLive.ts"
import { ThreadHandlers } from "./threads.ts"

// `threads.watch` and `threads.page` through the RPC server in process: the handlers' streams and errors. The
// websocket itself is the whole-server tier's (tests/e2e/threads.test.ts).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
/** The test clock's start, when every write here happens. */
const EPOCH = Timestamp.make("1970-01-01T00:00:00.000Z")

// A message's `type` does not narrow it (an event of a newer host's type is a message too): its schema does.
const isSnapshot = Schema.is(ThreadSnapshot)
const isAdded = Schema.is(ItemAdded)

/** The board token on every request, as a client of the board sends it. */
const BoardToken = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
  next({ ...request, headers: Headers.set(request.headers, "authorization", "Bearer test-token") }),
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ThreadHandlers, AuthLive, BoardToken).pipe(Layer.provideMerge(TestBoard()))))

describe("ThreadRpcs", () => {
  it.effect("watch streams a snapshot, then what the board writes; page has what is before a window", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const tasks = yield* Tasks
        const threads = yield* Threads
        const client = yield* RpcTest.makeClient(ThreadRpcs)
        yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`.pipe(Effect.orDie)
        const task = (yield* tasks.create({ profile_id: ProfileId.make("p") }, Actor.user).pipe(Effect.orDie)).id
        for (const text of ["a", "b", "c"]) yield* threads.notice(task, "info", text)
        const first = yield* Deferred.make<void>()
        const watcher = yield* client["threads.watch"]({ task_id: task, limit: 2 }).pipe(
          Stream.tap(() => Deferred.succeed(first, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Deferred.await(first)
        yield* threads.notice(task, "error", "d")
        const [snapshot, added] = yield* Fiber.join(watcher)
        assert.deepStrictEqual(isSnapshot(snapshot) ? [snapshot.seq, snapshot.start, snapshot.items.map((i) => i.id)] : null, [3, 1, ["legacy:2", "legacy:3"]])
        assert.deepStrictEqual(isAdded(added) ? [added.seq, added.item] : null, [
          4,
          { id: "legacy:4", type: "notice", level: "error", text: "d", created_at: EPOCH },
        ])
        const page = yield* client["threads.page"]({ task_id: task, before: 2, limit: 10 })
        assert.deepStrictEqual([page.start, page.items.map((i) => i.id), page.seq], [0, ["legacy:1", "legacy:2"], 4])
      }),
    ),
  )

  it.effect("a task that isn't there is NotFound", () =>
    run(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ThreadRpcs)
        const gone = TaskId.make("gone")
        const watched = yield* Effect.flip(Stream.runCollect(client["threads.watch"]({ task_id: gone, limit: 10 })))
        const paged = yield* Effect.flip(client["threads.page"]({ task_id: gone, before: 0, limit: 10 }))
        assert.deepStrictEqual(
          [watched, paged].map((e) => (e._tag === "NotFound" ? [e.what, e.id] : e._tag)),
          [
            ["task", "gone"],
            ["task", "gone"],
          ],
        )
      }),
    ),
  )
})
