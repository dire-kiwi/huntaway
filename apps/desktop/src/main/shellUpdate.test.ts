import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Digest } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { afterEach } from "vite-plus/test"
import { download, findPackage, shellReleaseOf, updateAppImage, updatePacman } from "./shellUpdate.ts"
import type { Package } from "./shellUpdate.ts"

// The old shell's desktop-shell-update.test.ts: GitHub (releases by tag, and downloads) is a plain HTTP server on
// 127.0.0.1, pkexec a stand-in script. The server's release status is given as it would come (`shellReleaseOf`).

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-shell-update-"))
  dirs.push(dir)
  return dir
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const PLATFORM = "linux-x64"
const PACKAGE = Buffer.from("the new package ".repeat(10_000))

interface FakeOptions {
  readonly release?: object | "rate-limited"
  readonly tag?: string
  readonly file?: Buffer
  readonly cut?: boolean
  readonly digest?: string | null
}

const Json = Schema.fromJsonString(Schema.Unknown)
const encode = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.orDie)

/** A fake GitHub on 127.0.0.1: release v0.3.0 (or `release`) by `tag`, and its downloads. `requests` logs every path. */
const fakeGitHub = (options: FakeOptions = {}) =>
  Effect.gen(function* () {
    const requests: Array<string> = []
    const tag = options.tag ?? "v0.3.0"
    const file = options.file ?? PACKAGE
    // Its answers, written once its address is known.
    const bodies = { release: "", rateLimited: "", notFound: "" }
    const server = createServer((request, response) => {
      const url = request.url ?? ""
      requests.push(url)
      const json = (code: number, body: string, headers: Record<string, string> = {}) => {
        response.writeHead(code, { "content-type": "application/json", ...headers })
        response.end(body)
      }
      if (url === `/repos/o/r/releases/tags/${tag}`) {
        if (options.release === "rate-limited") json(403, bodies.rateLimited, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" })
        else json(200, bodies.release)
      } else if (url.startsWith("/download/")) {
        response.writeHead(200, { "content-length": file.length })
        // A connection that drops halfway.
        if (options.cut === true) response.write(file.subarray(0, file.length / 2), () => response.destroy())
        else response.end(file)
      } else json(404, bodies.notFound)
    })
    const base = yield* Effect.acquireRelease(
      Effect.callback<string>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          resume(Effect.succeed(`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`))
        })
      }),
      () => Effect.sync(() => server.close()),
    )
    const digest = options.digest === undefined ? `sha256:${sha256(PACKAGE)}` : options.digest
    const asset = (name: string) => ({ name, browser_download_url: `${base}/download/${name}`, size: PACKAGE.length, digest })
    const release = options.release === undefined || options.release === "rate-limited" ? undefined : options.release
    bodies.release = yield* encode(
      release ?? { tag_name: tag, assets: [asset(`huntaway-0.3.0-${PLATFORM}.pacman`), asset("huntaway-0.3.0-linux-x86_64.AppImage")] },
    )
    bodies.rateLimited = yield* encode({ message: "API rate limit exceeded" })
    bodies.notFound = yield* encode({ message: "Not Found" })
    return { base, requests }
  })

/** findPackage for an AppImage against a fake GitHub made with `options`, failed. */
const findFailing = (options: FakeOptions) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(options)
    return yield* findPackage({ api: fake.base, repo: "o/r", version: "0.3.0", kind: "appimage", platform: PLATFORM }).pipe(Effect.flip)
  }).pipe(Effect.scoped)

const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto)

const appImageOf = (base: string): Package => ({
  name: "huntaway-0.3.0-linux-x86_64.AppImage",
  url: `${base}/download/huntaway-0.3.0-linux-x86_64.AppImage`,
  size: PACKAGE.length,
  sha256: sha256(PACKAGE),
})

/** A stand-in pkexec that logs its arguments and the package's hash, then prints `out` and exits with `code`. */
const stubPkexec = (code: number, out = "") => {
  const dir = temp()
  const log = join(dir, "log")
  writeFileSync(join(dir, "pkexec"), `#!/bin/sh\necho "$@" > ${log}\nsha256sum "$4" | cut -d' ' -f1 >> ${log}\nprintf '%s' '${out}' >&2\nexit ${code}\n`, {
    mode: 0o755,
  })
  return { pkexec: join(dir, "pkexec"), log: () => readFileSync(log, "utf8").trim().split("\n") }
}

describe("which release the app installs", () => {
  it("the server's latest, once its shell differs and it is newer than the app", () => {
    const status = { release: { latest: { version: "0.3.0" }, shell: { outdated: true } } }
    assert.deepStrictEqual(shellReleaseOf(status, "0.2.0"), { version: "0.3.0" })
    // An older app is updated, a prerelease of the release included.
    assert.deepStrictEqual(shellReleaseOf(status, "0.3.0-rc.2"), { version: "0.3.0" })
    const nothing = (s: typeof status | object, current: string) => {
      const found = shellReleaseOf(s, current)
      return "nothing" in found ? found.nothing : null
    }
    assert.match(nothing({ release: { latest: { version: "0.3.0" }, shell: { outdated: false } } }, "0.2.0") ?? "", /already has v0\.3\.0's shell/)
    assert.match(nothing({ release: { latest: null, shell: null } }, "0.2.0") ?? "", /hasn't found a release yet/)
    assert.match(nothing({}, "0.2.0") ?? "", /hasn't found a release yet/)
    // Installed from 0.4.0-rc.1 with prereleases off, the check picks 0.3.0: no downgrade, even if the server calls the shell outdated.
    for (const current of ["0.4.0-rc.1", "0.3.0"]) assert.match(nothing(status, current) ?? "", /isn't older than v0\.3\.0/)
  })
})

describe("finding the package on GitHub", () => {
  it.effect("by exact name, with its digest; a release tagged without a v is found too", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub({ tag: "0.3.0" })
      const pkg = yield* findPackage({ api: fake.base, repo: "o/r", version: "0.3.0", kind: "appimage", platform: PLATFORM })
      assert.deepStrictEqual(pkg, appImageOf(fake.base))
      assert.deepStrictEqual(
        fake.requests.filter((r) => r.includes("/tags/")),
        ["/repos/o/r/releases/tags/v0.3.0", "/repos/o/r/releases/tags/0.3.0"],
      )
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("nothing is installed when GitHub can't vouch for the package", () =>
    Effect.gen(function* () {
      assert.match(
        (yield* findFailing({ release: { tag_name: "v0.3.0", assets: [] } })).message,
        /Release v0\.3\.0 has no huntaway-0\.3\.0-linux-x86_64\.AppImage/,
      )
      assert.match((yield* findFailing({ release: "rate-limited" })).message, /rate limit for this address is used up until/)
      assert.match((yield* findFailing({ digest: null })).message, /no sha256 digest/)
      assert.match((yield* findFailing({ tag: "v9.9.9" })).message, /GitHub has no release v0\.3\.0 in o\/r/)
    }).pipe(Effect.provide(layer)),
  )
})

describe("downloading and installing the package", () => {
  it.effect("an AppImage is replaced in place by the verified download, keeping its mode", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub()
      const dir = temp()
      const appimage = join(dir, "Huntaway.AppImage")
      writeFileSync(appimage, "old", { mode: 0o750 })
      const progress: Array<readonly [number, number]> = []
      yield* updateAppImage({ appimage, pkg: appImageOf(fake.base), onProgress: (bytes, total) => Effect.sync(() => void progress.push([bytes, total])) })
      assert.strictEqual(sha256(readFileSync(appimage)), sha256(PACKAGE))
      assert.strictEqual(statSync(appimage).mode & 0o777, 0o751, "it keeps its mode, and is executable")
      assert.deepStrictEqual(readdirSync(dir), ["Huntaway.AppImage"], "no temp file is left")
      assert.deepStrictEqual(progress.at(-1), [PACKAGE.length, PACKAGE.length])
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("a download that doesn't match its digest, or is cut off, leaves the AppImage as it was", () =>
    Effect.gen(function* () {
      for (const [options, expected] of [
        [{ file: Buffer.from("tampered") }, /doesn't match its sha256 digest/],
        [{ cut: true }, /was cut off/],
      ] as const) {
        const error = yield* Effect.gen(function* () {
          const fake = yield* fakeGitHub(options)
          const dir = temp()
          const appimage = join(dir, "Huntaway.AppImage")
          writeFileSync(appimage, "old", { mode: 0o755 })
          const failed = yield* updateAppImage({ appimage, pkg: appImageOf(fake.base) }).pipe(Effect.flip)
          assert.strictEqual(readFileSync(appimage, "utf8"), "old")
          assert.deepStrictEqual(readdirSync(dir), ["Huntaway.AppImage"])
          return failed
        }).pipe(Effect.scoped)
        assert.match(error.message, expected)
      }
    }).pipe(Effect.provide(layer)),
  )

  // HA-68 review: a link planted at a predictable staging name beside the AppImage had the download written through it.
  it.effect("a file planted at the old staging name beside the AppImage isn't written through", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub()
      const dir = temp()
      const appimage = join(dir, "Huntaway.AppImage")
      writeFileSync(appimage, "old", { mode: 0o755 })
      const doc = join(temp(), "document.txt")
      writeFileSync(doc, "precious")
      symlinkSync(doc, join(dir, `.Huntaway.AppImage.update-${process.pid}`))
      yield* updateAppImage({ appimage, pkg: appImageOf(fake.base) })
      assert.strictEqual(readFileSync(doc, "utf8"), "precious")
      assert.isTrue(lstatSync(appimage).isFile(), "the AppImage is a regular file, not the link")
      assert.deepStrictEqual(readdirSync(dir).toSorted(), [`.Huntaway.AppImage.update-${process.pid}`, "Huntaway.AppImage"])
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("a download never writes through something already at its path", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub()
      const doc = join(temp(), "document.txt")
      writeFileSync(doc, "precious")
      const file = join(temp(), "package")
      symlinkSync(doc, file)
      const error = yield* download({ url: `${fake.base}/download/huntaway-0.3.0-${PLATFORM}.pacman`, file, sha256: sha256(PACKAGE) }).pipe(Effect.flip)
      assert.match(error.message, /Couldn't save the download in /)
      assert.strictEqual(readFileSync(doc, "utf8"), "precious")
      assert.isTrue(lstatSync(file).isSymbolicLink(), "and what's there is left alone")
      assert.isFalse(fake.requests.some((r) => r.startsWith("/download/")))
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect.skipIf(process.getuid?.() === 0)("an AppImage in a folder the user can't write says so before downloading", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub()
      const dir = temp()
      const appimage = join(dir, "Huntaway.AppImage")
      writeFileSync(appimage, "old", { mode: 0o755 })
      chmodSync(dir, 0o555)
      const error = yield* updateAppImage({ appimage, pkg: appImageOf(fake.base) }).pipe(Effect.flip)
      assert.include(error.message, `${dir} isn't writable`)
      assert.isFalse(fake.requests.some((r) => r.startsWith("/download/")))
      assert.strictEqual(readFileSync(appimage, "utf8"), "old")
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("pacman installs the verified download with pkexec, then cleans up", () =>
    Effect.gen(function* () {
      const fake = yield* fakeGitHub()
      const tmp = temp()
      const stub = stubPkexec(0)
      const pkg = yield* findPackage({ api: fake.base, repo: "o/r", version: "0.3.0", kind: "pacman", platform: PLATFORM })
      let installing = false
      yield* updatePacman({ pkg, tmpdir: tmp, pkexec: stub.pkexec, onInstalling: Effect.sync(() => void (installing = true)) })
      const [args, hash] = stub.log()
      assert.match(args ?? "", new RegExp(`^pacman -U --noconfirm ${realpathSync(tmp)}/huntaway-update-\\w+/huntaway-0\\.3\\.0-${PLATFORM}\\.pacman$`))
      assert.strictEqual(hash, sha256(PACKAGE))
      assert.isTrue(installing)
      assert.deepStrictEqual(readdirSync(tmp), [], "the download is removed")
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("a cancelled password prompt, no polkit agent, a pacman failure or no pkexec says so", () =>
    Effect.gen(function* () {
      const cases = [
        [126, "", /The password prompt was cancelled/],
        [127, "Error executing command as another user: No authentication agent found.", /there's no polkit agent running/],
        [1, "error: failed to commit transaction (conflicting files)", /pacman couldn't install the package \(exit 1\):\nerror: failed to commit transaction/],
      ] as const
      for (const [code, out, expected] of cases) {
        const tmp = temp()
        const error = yield* Effect.gen(function* () {
          const fake = yield* fakeGitHub()
          const pkg = yield* findPackage({ api: fake.base, repo: "o/r", version: "0.3.0", kind: "pacman", platform: PLATFORM })
          return yield* updatePacman({ pkg, tmpdir: tmp, pkexec: stubPkexec(code, out).pkexec }).pipe(Effect.flip)
        }).pipe(Effect.scoped)
        assert.match(error.message, expected)
        if (code !== 1) assert.match(error.message, /Install it with the sudo pacman command instead\.$/)
        assert.deepStrictEqual(readdirSync(tmp), [])
      }
      const tmp = temp()
      const error = yield* Effect.gen(function* () {
        const fake = yield* fakeGitHub()
        const pkg = yield* findPackage({ api: fake.base, repo: "o/r", version: "0.3.0", kind: "pacman", platform: PLATFORM })
        return yield* updatePacman({ pkg, tmpdir: tmp, pkexec: join(temp(), "no-pkexec") }).pipe(Effect.flip)
      }).pipe(Effect.scoped)
      assert.match(error.message, /pkexec isn't installed/)
      assert.deepStrictEqual(readdirSync(tmp), [])
    }).pipe(Effect.provide(layer)),
  )
})
