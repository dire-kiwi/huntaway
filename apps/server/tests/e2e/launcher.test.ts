import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { RpcClient } from "effect/rpc"
import { createServer } from "node:net"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { e2eDataDir } from "./launch.ts"
import { launcherUrl, launchServer } from "./supervised.ts"

// The launcher's supervision (plan task 8.1, after the old update/admin.test.ts's bin/huntaway cases): a restart keeps
// the process id, and gives the one-shot "start without a backup" to the first server only; a server that never came
// up isn't started again, one that crashed once up is, up to five times in a row, and one stopped from outside isn't;
// a release this host updated to is exec'd at startup, passing the server it was installed as on.

/** The processes whose parent is `pid`. */
const children = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`/proc/${pid}/task/${pid}/children`).pipe(Effect.orElseSucceed(() => ""))
    return text
      .trim()
      .split(/\s+/)
      .filter((p) => p !== "")
      .map(Number)
  })

/** The environment a process was started with. */
const environ = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`/proc/${pid}/environ`)
    return new Map(
      text
        .split("\0")
        .filter((kv) => kv !== "")
        .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as const),
    )
  })

const SERVE = (dataDir: string) => ["serve", "--port", "0", "--host", "127.0.0.1", "--data-dir", dataDir, "--no-agents"]

const makeClient = RpcClient.make(CliRpcs)
type Client = Effect.Success<typeof makeClient>

const rpc = <A, E>(port: number, token: string, f: (client: Client) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* makeClient)
  }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))

/**
 * `bin/huntaway serve` with a stand-in for node (`HUNTAWAY_NODE`) that says it's up, as a server does once it's
 * listening, then runs `then` (sh): how many times it ran, and the launcher's exit code and log.
 */
const crashingNode = (then: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-node-" })
    yield* fs.writeFileString(`${dir}/node`, `#!/bin/sh\necho run >> "${dir}/runs"\n: > "$(dirname "$HUNTAWAY_RESTART_FILE")/started"\n${then}\n`, {
      mode: 0o755,
    })
    const server = yield* launchServer(SERVE(dir), { HUNTAWAY_NODE: `${dir}/node`, HUNTAWAY_CRASH_BACKOFF: "0" })
    const code = yield* server.exited
    const runs = (yield* fs.readFileString(`${dir}/runs`)).split("\n").filter((l) => l !== "").length
    return { code, runs, log: yield* server.log }
  }).pipe(Effect.scoped)

describe("bin/huntaway", () => {
  it.live(
    "a restart keeps the process id, and the start without a backup is only the first server's",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* e2eDataDir
        const server = yield* launchServer(SERVE(dataDir), { HUNTAWAY_SKIP_DB_BACKUP_ONCE: "1" })
        const first = yield* server.nextReady
        const [node] = yield* children(server.pid)
        assert.isDefined(node)
        assert.strictEqual((yield* environ(node ?? 0)).get("HUNTAWAY_SKIP_DB_BACKUP_ONCE"), "1")
        const before = yield* rpc(first.port, first.token, (c) => c["admin.status"]())
        yield* rpc(first.port, first.token, (c) => c["admin.restart"]({}))
        const second = yield* server.nextReady
        const after = yield* rpc(second.port, second.token, (c) => c["admin.status"]())
        assert.notStrictEqual(after.boot_id, before.boot_id)
        // The same process (the launcher's), with a new node under it, which wasn't given the one-shot variable.
        const [again] = yield* children(server.pid)
        assert.isDefined(again)
        assert.notStrictEqual(again, node)
        assert.isUndefined((yield* environ(again ?? 0)).get("HUNTAWAY_SKIP_DB_BACKUP_ONCE"))
        assert.match(yield* server.log, /re-executing .*bin\/huntaway/)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live("a server that fails to start isn't started again", () =>
    Effect.gen(function* () {
      const dataDir = yield* e2eDataDir
      // Its port is taken.
      const taken = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const s = createServer()
          s.listen(0, "127.0.0.1", () => resume(Effect.succeed(s)))
        }),
        (s) => Effect.sync(() => s.close()),
      )
      const address = taken.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const server = yield* launchServer(["serve", "--port", String(port), "--host", "127.0.0.1", "--data-dir", dataDir, "--no-agents"], {
        HUNTAWAY_CRASH_BACKOFF: "0",
      })
      assert.strictEqual(yield* server.exited, 1)
      assert.notMatch(yield* server.log, /starting it again/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("gives up after five crashes in a row", () =>
    Effect.gen(function* () {
      const r = yield* crashingNode("exit 3")
      assert.strictEqual(r.runs, 6, r.log)
      assert.strictEqual(r.code, 3, "the server's own code")
      assert.match(r.log, /the server stopped with 3; starting it again in 0s \(5 of 5\)/)
      assert.match(r.log, /after starting it again 5 times in a row; giving up/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live("starts a server that aborted again, but not one killed, stopped or done", () =>
    Effect.gen(function* () {
      // 134 is how `wait` reports SIGABRT, which is how node ends when it runs out of memory.
      assert.strictEqual((yield* crashingNode("exit 134")).runs, 6)
      for (const signal of ["KILL", "TERM"]) {
        const r = yield* crashingNode(`kill -${signal} $$`)
        assert.strictEqual(r.runs, 1, `${signal}: ${r.log}`)
        assert.notMatch(r.log, /starting it again/)
      }
      assert.strictEqual((yield* crashingNode("exit 0")).runs, 1)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live("a release this host updated to is exec'd at startup, as the same process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* e2eDataDir
      const out = `${dataDir}/started`
      // A release in app/ that says how it was started, in place of serving.
      const dir = `${dataDir}/app/9.9.9`
      yield* fs.makeDirectory(`${dir}/ui`, { recursive: true })
      yield* fs.writeFileString(`${dir}/huntaway`, `#!/bin/sh\necho "$$ $HUNTAWAY_BUNDLED_SERVER $*" > ${out}\n`, { mode: 0o755 })
      yield* fs.writeFileString(`${dir}/ia-shim`, "")
      yield* fs.writeFileString(`${dir}/ui/index.html`, "")
      yield* fs.writeFileString(`${dataDir}/app/state.json`, '{"current":"9.9.9","bad":[]}')
      const args = [...SERVE(dataDir), "--release-updates", "o/r"]
      const server = yield* launchServer(args, { HUNTAWAY_DESKTOP_VERSION: undefined, HUNTAWAY_BUNDLED_SERVER: undefined })
      assert.strictEqual(yield* server.exited, 0)
      const [pid, bundled, ...given] = (yield* fs.readFileString(out)).trim().split(" ")
      assert.strictEqual(Number(pid), server.pid, "the release runs as the launcher's process")
      assert.strictEqual(bundled, yield* fs.realPath(yield* path.fromFileUrl(launcherUrl)), "so that Roll back can come back to this server")
      assert.deepStrictEqual(given, args)
      assert.include(yield* fs.readFileString(`${dataDir}/app/state.json`), '"trying":"9.9.9"')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
