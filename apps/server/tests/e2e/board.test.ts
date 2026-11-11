import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import type { BoardMessage } from "@huntaway/contracts"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// M1's "live across two tabs", at the protocol: two websocket sessions watch the board; a change made over HTTP by a
// third reaches both, after each one's snapshot.

const kind = (m: BoardMessage) => (m.type === "project" ? `project:${m.project.name}` : m.type)

/** A websocket session's first `n` board messages, read in the background; `snapshot` is done once it has its snapshot. */
const watch = (port: number, token: string, n: number) =>
  Effect.gen(function* () {
    const snapshot = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(CliRpcs)
      return yield* client["board.watch"]({}).pipe(
        Stream.tap((m) => (m.type === "snapshot" ? Deferred.succeed(snapshot, undefined) : Effect.void)),
        Stream.take(n),
        Stream.runCollect,
      )
    }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)), Effect.forkScoped)
    return { fiber, snapshot: Deferred.await(snapshot) }
  })

describe("board.watch over websockets", () => {
  it.live("two sessions see a snapshot, then a project made by a third, live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token } = yield* startServer()
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-e2e-repo-" })
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))

      const profile = yield* http["profiles.create"]({ profile: { name: "me" } })
      const first = yield* watch(port, token, 3)
      const second = yield* watch(port, token, 3)
      yield* first.snapshot
      yield* second.snapshot
      yield* http["projects.create"]({ project: { profile_id: profile.id, repo_path: repo, name: "Web" } })
      assert.deepStrictEqual((yield* Fiber.join(first.fiber)).map(kind), ["hello", "snapshot", "project:Web"])
      assert.deepStrictEqual((yield* Fiber.join(second.fiber)).map(kind), ["hello", "snapshot", "project:Web"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
