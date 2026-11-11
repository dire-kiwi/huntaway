import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { Digest } from "effect/crypto"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestPlatform, tempDir } from "@huntaway/testing"
import { Proc } from "../platform/Proc.ts"
import { CuaDriver } from "./CuaDriver.ts"
import { CuaInstall } from "./CuaInstall.ts"
import { pinnedRelease } from "./cua.ts"
import type { CuaRelease } from "./cua.ts"

// Installing Cua Driver (huntaway's desktop/tests.test.ts `installs_a_release_once_its_size_and_checksum_match_and_
// replaces_older_ones`): a release archive made here and served by a fake HTTP client, never GitHub's.

/** The archives the fake HTTP client serves, by URL. */
const served = new Map<string, Uint8Array>()

const fakeHttp = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const bytes = served.get(url.toString())
    return HttpClientResponse.fromWeb(request, bytes === undefined ? new Response("not found", { status: 404 }) : new Response(bytes.slice()))
  }),
)

/** No `HUNTAWAY_CUA_DRIVER`: `find` looks in the install folder (and on PATH, which the test's has no driver on). */
const TestInstall = CuaInstall.layer.pipe(
  Layer.provideMerge(CuaDriver.layer),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fakeHttp)),
  Layer.provideMerge(TestPlatform({ cuaDriver: null, path: "" })),
)

let made = 0
/** A release archive with `files` in it, served at a URL of its own; its release (with a wrong SHA-256 if `sha` is given). */
const release = (version: string, files: Readonly<Record<string, string>>, sha?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* tempDir
    yield* fs.makeDirectory(`${dir}/src`).pipe(Effect.orDie)
    for (const [name, body] of Object.entries(files)) yield* fs.writeFileString(`${dir}/src/${name}`, body, { mode: 0o755 }).pipe(Effect.orDie)
    const tar = yield* (yield* Proc).run("tar", ["-czf", `${dir}/a.tar.gz`, "-C", `${dir}/src`, "."]).pipe(Effect.orDie)
    assert.strictEqual(tar.code, 0, tar.stderr)
    const bytes = yield* fs.readFile(`${dir}/a.tar.gz`).pipe(Effect.orDie)
    const url = `http://downloads.test/${++made}/a.tar.gz`
    served.set(url, bytes)
    const r: CuaRelease = { version, url, bytes: bytes.byteLength, sha256: sha ?? (yield* (yield* Digest.Digest).digestHex(Digest.sha256, bytes)) }
    return r
  })

describe("installing Cua Driver", () => {
  it.effect("installs a release once its size and checksum match, and replaces older ones", () =>
    Effect.gen(function* () {
      const install = yield* CuaInstall
      const driver = yield* CuaDriver
      const failure = (r: CuaRelease) => Effect.flip(install.install(r)).pipe(Effect.map((e) => e.reason))

      assert.include(yield* failure(yield* release("1.0.0", { "cua-driver": "#!/bin/sh\n" }, "0".repeat(64))), "SHA-256")
      assert.isNull(yield* driver.find)
      assert.include(yield* failure(yield* release("1.0.0", { other: "x" })), "no cua-driver")
      const short = yield* release("1.0.0", { "cua-driver": "#!/bin/sh\n" })
      assert.include(yield* failure({ ...short, bytes: short.bytes - 1 }), "bigger than the release's")
      assert.include(yield* failure({ ...short, url: "http://downloads.test/none" }), "HTTP 404")

      yield* install.install(yield* release("1.0.0", { "cua-driver": "#!/bin/sh\necho old\n" }))
      assert.deepStrictEqual(yield* driver.find, { path: `${driver.installRoot}/1.0.0/cua-driver`, source: "installed", version: "1.0.0" })
      yield* install.install(yield* release("1.1.0", { "cua-driver": "#!/bin/sh\necho new\n" }))
      assert.deepStrictEqual(yield* driver.installedVersions, ["1.1.0"])
      assert.strictEqual((yield* driver.find)?.version, "1.1.0")
      // Nothing half-written is left beside them.
      assert.deepStrictEqual(yield* (yield* FileSystem.FileSystem).readDirectory(driver.installRoot), ["1.1.0"])
      yield* install.uninstall
      assert.strictEqual((yield* driver.installedVersions).length, 0)
    }).pipe(Effect.provide(TestInstall)),
  )

  it.effect("the page's install goes in the background and says how it went", () =>
    Effect.gen(function* () {
      const install = yield* CuaInstall
      const r = yield* release("2.0.0", { "cua-driver": "#!/bin/sh\n" })
      const started = yield* install.start(r)
      assert.deepStrictEqual([started.phase, started.total, started.version], ["downloading", r.bytes, "2.0.0"])
      // Another start while it goes is the same install.
      assert.strictEqual((yield* install.start(r)).started_at, started.started_at)
      const done = yield* install.settled
      assert.deepStrictEqual([done?.phase, done?.received, done?.error], ["done", r.bytes, null])
      assert.strictEqual((yield* (yield* CuaDriver).find)?.version, "2.0.0")
    }).pipe(Effect.provide(TestInstall)),
  )

  it("pins a release for Linux and macOS, and none elsewhere", () => {
    assert.strictEqual(
      pinnedRelease("linux", "x64")?.url,
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.41.3/cua-driver-rs-0.41.3-linux-x86_64-binary.tar.gz",
    )
    assert.strictEqual(pinnedRelease("darwin", "arm64")?.bytes, 54_042_598)
    assert.isNull(pinnedRelease("win32", "x64"))
    assert.isNull(pinnedRelease("linux", "ia32"))
  })
})
