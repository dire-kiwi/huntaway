import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Digest } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { afterEach } from "vite-plus/test"
import { Desktop } from "./Desktop.ts"
import type { DesktopShape } from "./Desktop.ts"
import { Servers } from "./Servers.ts"

// Finding or starting the server, for real: launchers that are shell scripts standing in for bin/huntaway (they print
// the ready line, exit, or say the backup failed), on a free port of 127.0.0.1 with a temp data folder, and a plain
// HTTP server standing in for a server already running. Each test waits on what the processes print, not on time.

const Json = Schema.fromJsonString(Schema.Unknown)

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-servers-"))
  dirs.push(dir)
  return dir
}

/** A port nothing listens on (asked of the system, then let go). */
const freePort = () =>
  Effect.callback<number>((resume) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resume(Effect.succeed(port)))
    })
  })

type Behaviour = "ready" | "exit" | "backup"

/**
 * A stand-in launcher at `file`: it records its arguments, environment and pid beside itself, then says it is ready (and
 * waits to be stopped), exits, or says it couldn't back up the database and exits. Each start appends to `<file>.starts`.
 */
const launcher = (file: string, behaviour: Behaviour, token = "tok") => {
  mkdirSync(dirname(file), { recursive: true })
  const says = {
    ready: `echo 'HUNTAWAY_READY {"port":1,"token":"${token}"}'\nexec sleep 600`,
    exit: "echo 'it went wrong' >&2\nexit 1",
    backup: `echo 'HUNTAWAY_BACKUP_FAILED {"reason":"space","why":"No space left on device","dir":"/backups"}'\nexit 1`,
  }[behaviour]
  writeFileSync(file, `#!/bin/sh\necho "$*" > "$0.args"\nenv > "$0.env"\necho $$ > "$0.pid"\necho x >> "$0.starts"\n${says}\n`)
  chmodSync(file, 0o755)
  return file
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const serversLayer = (desktop: Partial<DesktopShape> & { readonly dataDir: string; readonly port: number }) =>
  Servers.layer.pipe(
    Layer.provideMerge(Desktop.layerTest(desktop)),
    Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, Digest.layerWebCrypto)),
    Layer.provideMerge(NodeServices.layer),
  )

const resolve = Effect.gen(function* () {
  const servers = yield* Servers
  return yield* servers.resolve
})

/** An HTTP server on `port` that answers `/api/health` as a Huntaway server does. */
const healthServer = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((request, response) => {
        response.writeHead(request.url === "/api/health" ? 200 : 404, { "content-type": "application/json" })
        response.end("{}")
      })
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)))
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  )

describe("Servers", () => {
  it.live("starts the launcher on the port with the data folder, reads its token, and stops it with the app", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      const bin = launcher(join(dir, "bin", "huntaway"), "ready", "the-token")
      const target = yield* resolve.pipe(Effect.provide(serversLayer({ dataDir: join(dir, "data"), port, serverBin: bin })))
      assert.deepStrictEqual(target, { base: `http://127.0.0.1:${port}`, token: "the-token" })
      assert.strictEqual(readFileSync(`${bin}.args`, "utf8").trim(), `serve --port ${port} --data-dir ${join(dir, "data")}`)
      const pid = Number(readFileSync(`${bin}.pid`, "utf8"))
      // The layer is closed: the server started here was stopped (SIGTERM to the launcher).
      assert.isFalse(alive(pid))
      // A checkout's shell doesn't turn on release updates.
      assert.notInclude(readFileSync(`${bin}.env`, "utf8"), "HUNTAWAY_DESKTOP_VERSION")
    }),
  )

  it.live("windows that load together share one start", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      const bin = launcher(join(dir, "bin", "huntaway"), "ready")
      const targets = yield* Effect.all([resolve, resolve, resolve], { concurrency: "unbounded" }).pipe(
        Effect.provide(serversLayer({ dataDir: join(dir, "data"), port, serverBin: bin })),
      )
      assert.strictEqual(new Set(targets.map((t) => t.token)).size, 1)
      assert.strictEqual(readFileSync(`${bin}.starts`, "utf8"), "x\n")
    }),
  )

  it.live("uses a server already answering on the port, with the data folder's token, and starts nothing", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      yield* healthServer(port)
      mkdirSync(join(dir, "data"))
      writeFileSync(join(dir, "data", "auth_token"), "from-the-file\n")
      const bin = launcher(join(dir, "bin", "huntaway"), "ready")
      const target = yield* resolve.pipe(Effect.provide(serversLayer({ dataDir: join(dir, "data"), port, serverBin: bin })))
      assert.deepStrictEqual(target, { base: `http://127.0.0.1:${port}`, token: "from-the-file" })
      assert.isFalse(existsSync(`${bin}.starts`))
    }).pipe(Effect.scoped),
  )

  it.live("remote mode uses the configured server and starts nothing", () =>
    Effect.gen(function* () {
      const dir = temp()
      const bin = launcher(join(dir, "bin", "huntaway"), "ready")
      const file = { port: null, dataDir: null, host: null, serverBin: null, serverUrl: "https://board.example.invalid/", token: "remote", skipDbBackup: false }
      const target = yield* resolve.pipe(Effect.provide(serversLayer({ dataDir: join(dir, "data"), port: 1, serverBin: bin, file })))
      assert.deepStrictEqual(target, { base: "https://board.example.invalid", token: "remote" })
      assert.isFalse(existsSync(`${bin}.starts`))
    }),
  )

  it.live("a release build passes over an installed version that exits before it's ready, and marks it bad once another is up", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      const data = join(dir, "data")
      const appDir = join(data, "app")
      const resources = join(dir, "resources")
      const install = (version: string, behaviour: Behaviour) => {
        launcher(join(appDir, version, "huntaway"), behaviour, `tok-${version}`)
        for (const file of ["ia-shim", "ui/index.html"]) {
          mkdirSync(dirname(join(appDir, version, file)), { recursive: true })
          writeFileSync(join(appDir, version, file), "")
        }
      }
      install("0.3.0", "exit")
      install("0.2.0", "ready")
      launcher(join(resources, "huntaway"), "ready", "tok-bundled")
      writeFileSync(join(appDir, "state.json"), '{"current": "0.3.0", "previous": "0.2.0", "bad": [], "extra": 42}')
      const target = yield* resolve.pipe(Effect.provide(serversLayer({ dataDir: data, port, resourcesDir: resources, appVersion: "0.1.0" })))
      assert.strictEqual(target.token, "tok-0.2.0")
      assert.deepStrictEqual(yield* Schema.decodeEffect(Json)(readFileSync(join(appDir, "state.json"), "utf8")), {
        current: "0.3.0",
        previous: "0.2.0",
        bad: ["0.3.0"],
        extra: 42,
      })
      assert.isFalse(existsSync(join(resources, "huntaway.starts")))
      // A release build's server gets release updates and is told about the app.
      const env = readFileSync(join(appDir, "0.2.0", "huntaway.env"), "utf8")
      assert.include(env, "HUNTAWAY_RELEASE_UPDATES=dire-kiwi/huntaway-effect")
      assert.include(env, "HUNTAWAY_DESKTOP_VERSION=0.1.0")
      assert.include(env, "HUNTAWAY_DESKTOP_INSTALL=other")
      assert.include(env, `HUNTAWAY_BUNDLED_SERVER=${join(resources, "huntaway")}`)
    }),
  )

  it.live("a server that couldn't back up the database says why, and no version is blamed", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      const data = join(dir, "data")
      const resources = join(dir, "resources")
      launcher(join(resources, "huntaway"), "backup")
      const error = yield* resolve.pipe(Effect.provide(serversLayer({ dataDir: data, port, resourcesDir: resources })), Effect.flip)
      assert.strictEqual(error.backup?.reason, "space")
      assert.strictEqual(error.message, "It couldn't back up the database: No space left on device")
      assert.isFalse(existsSync(join(data, "app", "state.json")))
    }),
  )

  it.live("a server that exits at once fails the start with its exit, and its last output is kept for the error page", () =>
    Effect.gen(function* () {
      const dir = temp()
      const port = yield* freePort()
      const bin = launcher(join(dir, "bin", "huntaway"), "exit")
      const { error, log } = yield* Effect.gen(function* () {
        const servers = yield* Servers
        return { error: yield* Effect.flip(servers.resolve), log: yield* servers.log }
      }).pipe(Effect.provide(serversLayer({ dataDir: join(dir, "data"), port, serverBin: bin })))
      assert.strictEqual(error.message, "Server exited with code 1")
      assert.deepStrictEqual(log, ["it went wrong"])
    }),
  )
})
