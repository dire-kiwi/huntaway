import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { e2eDataDir, socketRpcClientLayer } from "./launch.ts"
import { launcherUrl, launchServer } from "./supervised.ts"

// A server updates itself from a release and rolls back from a broken one (plan task 8.2's whole-server test, after the
// old scripts/release-update-e2e.mjs): a fake GitHub serves releases of this checkout; the server, started through the
// launcher with --release-updates, checks, downloads, verifies and stages one, and its Update execs it through the
// launcher's restart file (the same process); the new version settles as current. A release that fails its smoke
// test is refused at staging. A release that passes it but never comes up exits; started again (as a service manager
// would), the server marks it bad and runs the good one. Roll back goes back to the server the host was installed as.

const launcher = launcherUrl
const entry = new URL("../../src/bin.ts", import.meta.url)
const PLATFORM = `${process.platform === "darwin" ? "mac" : process.platform}-${process.arch}`

/** A release's server: this checkout's, with the release's build.json; or one that never comes up; or a wrong `--version`. */
type Kind = "good" | "never_up" | "wrong_version"

/** A server tarball for `version` in the release layout: one top folder with `huntaway`, `ia-shim`, `ui/`, `build.json`. */
const tarball = (version: string, kind: Kind): Buffer => {
  const dir = mkdtempSync(`${tmpdir()}/huntaway-release-`)
  try {
    const top = `huntaway-server-${version}-${PLATFORM}`
    const root = `${dir}/${top}`
    mkdirSync(`${root}/server/src`, { recursive: true })
    mkdirSync(`${root}/ui`)
    // The launcher as a release has it; it runs server/src/bin.ts with the Node it finds.
    copyFileSync(launcher, `${root}/huntaway`)
    chmodSync(`${root}/huntaway`, 0o755)
    writeFileSync(`${root}/ia-shim`, "not run: the test servers run no agents\n")
    writeFileSync(`${root}/ui/index.html`, `<html>release ${version}</html>\n`)
    writeFileSync(`${root}/build.json`, `{ "version": "${version}", "commit": "${commitOf(version)}" }\n`)
    writeFileSync(
      `${root}/server/src/bin.ts`,
      kind === "good"
        ? `import "${entry.href}"\n`
        : kind === "never_up"
          ? `if (process.argv[2] === "--version") console.log("huntaway ${version}")\nelse { console.error("this release never comes up"); process.exit(1) }\n`
          : `console.log("huntaway 0.0.1")\n`,
    )
    execFileSync("tar", ["-czf", `${dir}/out.tar.gz`, top], { cwd: dir })
    return readFileSync(`${dir}/out.tar.gz`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The commit a test release says it was built from. */
const commitOf = (version: string) => version.replaceAll(".", "").padEnd(40, "c")

/** A release as GitHub's API lists it, with its server tarball (plain values, so written as JSON by hand). */
const releaseJson = (url: string, version: string, name: string, bytes: Buffer) =>
  `{"tag_name":"v${version}","draft":false,"prerelease":false,"published_at":"2026-11-12T00:00:00Z","body":"notes for ${version}",` +
  `"html_url":"https://github.com/o/r/releases/tag/v${version}","assets":[{"name":"${name}","browser_download_url":"${url}/download/${name}",` +
  `"size":${bytes.length},"digest":"sha256:${createHash("sha256").update(bytes).digest("hex")}"}]}`

/** A fake GitHub on a free port: its releases API and the downloads, for the scope. */
const fakeGithub = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly publish: (version: string, kind: Kind) => void; readonly close: () => void }>((resume) => {
    const releases: Array<string> = []
    const files = new Map<string, Buffer>()
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname
      if (path === "/repos/o/r/releases") {
        res.writeHead(200, { "content-type": "application/json", etag: `"${releases.length}"` }).end(`[${releases.join(",")}]`)
        return
      }
      const file = files.get(decodeURIComponent(path.replace(/^\/download\//, "")))
      if (file === undefined) res.writeHead(404).end()
      else res.writeHead(200, { "content-length": String(file.length) }).end(file)
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
      resume(
        Effect.succeed({
          url,
          publish: (version, kind) => {
            const bytes = tarball(version, kind)
            const name = `huntaway-server-${version}-${PLATFORM}.tar.gz`
            files.set(name, bytes)
            releases.unshift(releaseJson(url, version, name, bytes))
          },
          close: () => {
            server.closeAllConnections()
            server.close()
          },
        }),
      )
    })
  }),
  (github) => Effect.sync(github.close),
)

/** `bin/huntaway serve` on `dataDir` with release updates from the fake GitHub, as a service manager starts it. */
const launch = (dataDir: string, api: string) =>
  launchServer(["serve", "--port", "0", "--host", "127.0.0.1", "--data-dir", dataDir, "--no-agents", "--release-updates", "o/r"], {
    HUNTAWAY_RELEASE_API: api,
    HUNTAWAY_BUNDLED_SERVER: undefined,
    HUNTAWAY_DESKTOP_VERSION: undefined,
  })

/** One typed call to the server on `port`. */
const makeClient = RpcClient.make(CliRpcs)
type Client = Effect.Success<typeof makeClient>

const rpc = <A, E>(port: number, token: string, f: (client: Client) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const client = yield* makeClient
    return yield* f(client)
  }).pipe(Effect.scoped, Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))

/** Check for releases, and wait until the download that follows has finished: null once staged, else the failure. */
const checkAndWait = (port: number, token: string) =>
  Effect.gen(function* () {
    const socket = yield* RpcClient.make(CliRpcs)
    const subscribed = yield* Deferred.make<void>()
    const finished = yield* socket["board.watch"]({}).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.filter((m) => m.type === "release_download" && (m.download === null || m.download.phase === "failed")),
      Stream.take(1),
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Deferred.await(subscribed)
    yield* rpc(port, token, (c) => c["admin.checkRelease"]())
    const event = Option.getOrThrow(yield* Fiber.join(finished))
    return event.type === "release_download" ? event.download : null
  }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

/** `app/state.json`. */
const installed = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          current: Schema.NullOr(Schema.String),
          previous: Schema.NullOr(Schema.String),
          staged: Schema.NullOr(Schema.String),
          trying: Schema.NullOr(Schema.String),
          bad: Schema.Array(Schema.String),
        }),
      ),
    )(yield* fs.readFileString(`${dataDir}/app/state.json`))
  })

describe("release updates, through the launcher", () => {
  it.live(
    "a server updates itself from a staged release, refuses and rolls back from broken ones, and rolls back to what it was installed as",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const github = yield* fakeGithub
        const dataDir = yield* e2eDataDir
        const installedAs = yield* path.fromFileUrl(launcher)
        github.publish("0.2.0", "good")

        // The checkout's server (0.1.0) checks, downloads, verifies and stages 0.2.0, and goes on running.
        const server = yield* launch(dataDir, github.url)
        const first = yield* server.nextReady
        assert.isNull(yield* checkAndWait(first.port, first.token))
        const before = yield* rpc(first.port, first.token, (c) => c["admin.status"]())
        assert.strictEqual(before.version, "0.1.0")
        assert.deepStrictEqual([before.release?.latest?.version, before.release?.staged, before.release?.rollback_to], ["0.2.0", "0.2.0", null])
        assert.deepStrictEqual((yield* fs.readDirectory(`${dataDir}/app`)).toSorted(), ["0.2.0", "state.json"])

        // Update: the launcher execs 0.2.0 in the same process, which settles as current.
        yield* rpc(first.port, first.token, (c) => c["admin.updateRelease"]({ version: "0.2.0" }))
        const second = yield* server.nextReady
        const updated = yield* rpc(second.port, second.token, (c) => c["admin.status"]())
        assert.strictEqual(updated.version, "0.2.0")
        assert.notStrictEqual(updated.boot_id, before.boot_id)
        assert.strictEqual(updated.release?.exe, `${dataDir}/app/0.2.0/huntaway`)
        // Roll back would go to the server the host was installed as, which the Update passed on.
        assert.deepStrictEqual([updated.release?.bundled_server, updated.release?.rollback_to], [installedAs, "bundled"])
        const health = yield* rpc(second.port, second.token, (c) => c["public.health"]())
        assert.deepStrictEqual([health.version, health.commit], ["0.2.0", commitOf("0.2.0")])
        assert.deepStrictEqual(yield* installed(dataDir), { current: "0.2.0", previous: null, staged: null, trying: null, bad: [] })

        // A release whose `--version` says another version is refused at staging; 0.2.0 runs on.
        github.publish("0.3.0", "wrong_version")
        const refused = yield* checkAndWait(second.port, second.token)
        assert.include(refused?.error ?? "", 'printed "huntaway 0.0.1", not 0.3.0')
        assert.deepStrictEqual((yield* fs.readDirectory(`${dataDir}/app`)).toSorted(), ["0.2.0", "state.json"])

        // A release that passes its smoke test but never comes up: the Update execs it, it exits, and so does the
        // process (nothing restarts a server that never said it was up).
        github.publish("0.4.0", "never_up")
        assert.isNull(yield* checkAndWait(second.port, second.token))
        yield* rpc(second.port, second.token, (c) => c["admin.updateRelease"]({ version: "0.4.0" }))
        assert.notStrictEqual(yield* server.exited, 0)
        assert.strictEqual((yield* installed(dataDir)).trying, "0.4.0")

        // Started again as a service manager would, the server it was installed as marks 0.4.0 bad and runs 0.2.0.
        const again = yield* launch(dataDir, github.url)
        const third = yield* again.nextReady
        const back = yield* rpc(third.port, third.token, (c) => c["admin.status"]())
        assert.strictEqual(back.version, "0.2.0")
        assert.deepStrictEqual(yield* installed(dataDir), { current: "0.2.0", previous: null, staged: null, trying: null, bad: ["0.4.0"] })
        assert.include(yield* again.log, "release 0.4.0 didn't start last time")
        // And it isn't offered again.
        const offered = yield* rpc(third.port, third.token, (c) => c["admin.checkRelease"]())
        assert.notStrictEqual(offered.release?.latest?.version, "0.4.0")

        // Roll back: 0.2.0 is marked bad and the server the host was installed as runs again, in the same process.
        yield* rpc(third.port, third.token, (c) => c["admin.rollback"]())
        const fourth = yield* again.nextReady
        const rolled = yield* rpc(fourth.port, fourth.token, (c) => c["admin.status"]())
        assert.strictEqual(rolled.version, "0.1.0")
        const state = yield* installed(dataDir)
        assert.deepStrictEqual([state.current, state.bad.toSorted()], [null, ["0.2.0", "0.4.0"]])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  )
})
