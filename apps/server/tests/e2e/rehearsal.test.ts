import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Auth } from "@huntaway/contracts"
import { importedFolder } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// The guard and the read-only server through the launcher (docs/plan/11-migration.md, The guard; Rehearsal): a server
// on a rehearsal folder listens on 127.0.0.1 though no `--host` was given, still wants the token, says it is read-only
// and refuses a change; a server on a switch's folder does not start while a process has the old database open.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

/** The typed client over HTTP with no `authorization` header at all. */
const noToken = (url: string) =>
  Layer.mergeAll(
    RpcClient.layerProtocolHttp({ url: `${url}/api/rpc` }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson)),
    RpcMiddleware.layerClient(Auth, ({ next, request }) => next(request)),
  )

const launcher = new URL("../../bin/huntaway", import.meta.url)

describe("an imported folder, through the launcher", () => {
  it.live("a rehearsal's server listens on 127.0.0.1, wants the token, is read-only and refuses changes", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: true })
      // No --host: a rehearsal listens on this machine only unless told otherwise.
      const { port, token, log } = yield* startServer(["--no-agents"], {}, folder.dataDir, null)
      assert.strictEqual(token, folder.token)
      assert.include(yield* log, `listening on http://127.0.0.1:${port}`)
      const url = `http://127.0.0.1:${port}`

      const anonymous = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CliRpcs)
        return yield* Effect.flip(client["host.info"]())
      }).pipe(Effect.scoped, Effect.provide(noToken(url)))
      assert.strictEqual(anonymous._tag, "Unauthorized")
      const wrong = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CliRpcs)
        return yield* Effect.flip(client["tasks.get"]({ id: folder.task }))
      }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(url, "not-the-token")))
      assert.strictEqual(wrong._tag, "Unauthorized")

      const { info, task, open, created } = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CliRpcs)
        return {
          info: yield* client["host.info"](),
          task: yield* client["tasks.get"]({ id: folder.task }),
          // No token-less way in: the open token is never given.
          open: (yield* Effect.flip(client["public.openToken"]()))._tag,
          created: yield* Effect.flip(client["tasks.create"]({ task: { project_id: folder.project, title: "Not on a rehearsal" } })),
        }
      }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(url, token)))
      assert.deepStrictEqual([info.read_only, info.rehearsal, info.agents], [true, { from: folder.oldDir, imported_at: folder.record.at }, false])
      assert.strictEqual(task.id, folder.task)
      assert.strictEqual(open, "NotFound")
      assert.deepStrictEqual(created._tag === "Forbidden" ? [created._tag, created.scope] : created._tag, ["Forbidden", "operate"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("a switch's server refuses to start while a process has the old database open", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: false })
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // The old server, as far as the guard can tell: a process with its database open.
      const old = yield* spawner.spawn(ChildProcess.make("sh", ["-c", 'exec 3<"$1"; echo open; exec sleep 600', "sh", `${folder.oldDir}/huntaway-2.db`]))
      yield* old.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line === "open"),
        Stream.runHead,
      )

      const bin = yield* (yield* Path.Path).fromFileUrl(launcher)
      const server = yield* spawner.spawn(ChildProcess.make(bin, ["serve", "--port", "0", "--host", "127.0.0.1", "--no-agents", "--data-dir", folder.dataDir]))
      const stderr = yield* Ref.make("")
      yield* server.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) => Ref.update(stderr, (all) => all + text)),
        Effect.forkScoped,
      )
      const stdout = yield* server.stdout.pipe(Stream.decodeText(), Stream.mkString)
      const code = yield* server.exitCode.pipe(Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the server was still running") }))
      assert.strictEqual(Number(code), 1)
      assert.notInclude(stdout, "HUNTAWAY_READY")
      const said = yield* Ref.get(stderr)
      assert.include(said, `process ${old.pid}`)
      assert.include(said, "stop the old server")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
