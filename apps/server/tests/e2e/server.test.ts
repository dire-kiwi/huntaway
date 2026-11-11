import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { RpcClient } from "effect/rpc"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// The whole-server tier's first test (docs/plan/13-milestones.md, 0.3): a server started through the launcher, as a
// service manager or the desktop app starts it, answers the typed client over HTTP and stops on SIGTERM.

/** The ids of the processes whose command line mentions `text`. */
const processesMentioning = Effect.fn(function* (text: string) {
  const fs = yield* FileSystem.FileSystem
  const pids = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name))
  const found = yield* Effect.forEach(
    pids,
    (pid) =>
      fs.readFileString(`/proc/${pid}/cmdline`).pipe(
        Effect.map((cmdline) => (cmdline.includes(text) ? [pid] : [])),
        // Gone meanwhile, or not ours to read.
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 16 },
  )
  return found.flat()
})

describe("the server, through its launcher", () => {
  it.live("starts on a free port, answers the typed client and stops on SIGTERM", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { port, token, dataDir, process: server } = yield* startServer()
      assert.isAbove(port, 0)
      assert.notStrictEqual(token, "")

      const { health, info } = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CliRpcs)
        return { health: yield* client["public.health"](), info: yield* client["host.info"]() }
      }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      assert.isTrue(health.ok)
      assert.strictEqual(info.host_id, health.host_id)
      assert.strictEqual((yield* fs.readFileString(path.join(dataDir, "host_id"))).trim(), health.host_id)

      // SIGTERM to the launcher's process group, as a service manager sends it: the server's shutdown gives its
      // finalizers 2 seconds, then exits regardless, and the launcher exits with it.
      yield* server
        .kill({ killSignal: "SIGTERM" })
        .pipe(
          Effect.andThen(server.exitCode),
          Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.die("the server was still running 3 seconds after SIGTERM") }),
        )
      assert.deepStrictEqual(yield* processesMentioning(dataDir), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
