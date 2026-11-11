import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, FileSystem, Path, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"

// The whole-server tier's first test (docs/plan/13-milestones.md, 0.3): a server started through the launcher, as a
// service manager or the desktop app starts it, answers the typed client over HTTP and stops on SIGTERM.

const launcher = new URL("../../bin/huntaway", import.meta.url)

const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int, token: Schema.NullOr(Schema.String) }))

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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-e2e-" })
      const bin = yield* path.fromFileUrl(launcher)

      const server = yield* spawner.spawn(ChildProcess.make(bin, ["serve", "--port", "0", "--host", "127.0.0.1", "--data-dir", dataDir]))
      // Its stdout carries the ready line; its log (stderr) is kept to show if it never gets there. Both are read to
      // their end, so neither pipe fills.
      const ready = yield* Deferred.make<string>()
      const log = yield* Ref.make("")
      yield* server.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => (line.startsWith("HUNTAWAY_READY ") ? Deferred.succeed(ready, line.slice("HUNTAWAY_READY ".length)) : Effect.void)),
        Effect.forkScoped,
      )
      yield* server.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) => Ref.update(log, (all) => all + text)),
        Effect.forkScoped,
      )
      const line = yield* Effect.raceFirst(
        Deferred.await(ready),
        server.exitCode.pipe(Effect.andThen((code) => Ref.get(log).pipe(Effect.andThen((text) => Effect.die(`the server exited with ${code}:\n${text}`))))),
      )
      const { port, token } = yield* Schema.decodeEffect(ReadyLine)(line)
      assert.isAbove(port, 0)
      assert.isNotNull(token)

      const { health, info } = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CliRpcs)
        return { health: yield* client["public.health"](), info: yield* client["host.info"]() }
      }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token ?? "")))
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
