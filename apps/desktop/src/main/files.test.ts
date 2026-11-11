import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Digest } from "effect/crypto"
import { afterEach } from "vite-plus/test"
import { markVersionBad, readAppState } from "./appState.ts"
import { desktopFile } from "./Desktop.ts"
import { errorPage } from "./errorPage.ts"
import { refused } from "./health.ts"
import { backupFailure, readyToken } from "./ServerProcess.ts"
import { frameStamp, shellStamp } from "./stamp.ts"
import { badgeCount, boardUrlPath, isBrowsable, isWebUrl, RETRY_URL, SKIP_BACKUP_URL, windowsToReopen } from "./urls.ts"

// The main process's smaller parts: state.json as both writers keep it, the stamps, what the server prints, the
// windows' address rules and the error page.

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-files-"))
  dirs.push(dir)
  return dir
}

const layer = Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto)
const Json = Schema.fromJsonString(Schema.Unknown)

describe("app/state.json", () => {
  it.effect("marking a version bad keeps the keys the shell doesn't know, through a temp file and a rename", () =>
    Effect.gen(function* () {
      const dir = temp()
      writeFileSync(join(dir, "state.json"), '{"current": "0.2.0", "trying": "0.3.0", "bad": ["0.0.9"], "extra": {"kept": true}}')
      yield* markVersionBad(dir, "0.3.0")
      yield* markVersionBad(dir, "0.3.0")
      assert.deepStrictEqual(yield* Schema.decodeEffect(Json)(readFileSync(join(dir, "state.json"), "utf8")), {
        current: "0.2.0",
        trying: null,
        bad: ["0.0.9", "0.3.0"],
        extra: { kept: true },
      })
      assert.isTrue(readFileSync(join(dir, "state.json"), "utf8").startsWith('{\n  "current"'))
      assert.deepStrictEqual(
        readdirSync(dir).filter((f) => f.endsWith(".tmp")),
        [],
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("one that is missing or doesn't parse reads as {}", () =>
    Effect.gen(function* () {
      const dir = temp()
      assert.deepStrictEqual(yield* readAppState(join(dir, "none")), {})
      writeFileSync(join(dir, "state.json"), "{not json")
      assert.deepStrictEqual(yield* readAppState(dir), {})
      writeFileSync(join(dir, "state.json"), "[1]")
      assert.deepStrictEqual(yield* readAppState(dir), {})
    }).pipe(Effect.provide(layer)),
  )
})

describe("stamps", () => {
  it.effect("the frame stamp changes with boot.cjs and Electron, not with the rest of the shell, and is the old stamp's", () =>
    Effect.gen(function* () {
      const dir = temp()
      writeFileSync(join(dir, "boot.cjs"), "boot")
      writeFileSync(join(dir, "main.cjs"), "main")
      const frame = yield* frameStamp(dir, "45.3.0")
      // As the old stamp.cjs computed it: sha256 over the file's name, its contents, then the Electron version.
      assert.strictEqual(frame, createHash("sha256").update("boot.cjs").update("boot").update("45.3.0").digest("hex"))
      const shell = yield* shellStamp(dir, "45.3.0")
      writeFileSync(join(dir, "main.cjs"), "main, changed")
      writeFileSync(join(dir, "preload.cjs"), "new file")
      assert.strictEqual(yield* frameStamp(dir, "45.3.0"), frame)
      assert.notStrictEqual(yield* shellStamp(dir, "45.3.0"), shell)
      assert.notStrictEqual(yield* frameStamp(dir, "45.3.1"), frame)
      writeFileSync(join(dir, "boot.cjs"), "boot, changed")
      assert.notStrictEqual(yield* frameStamp(dir, "45.3.0"), frame)
      // A folder that's gone (a Roll back pruned it) fails, which the caller takes as no change.
      assert.isTrue(Option.isNone(yield* Effect.option(shellStamp(join(dir, "gone"), "45.3.0"))))
    }).pipe(Effect.provide(layer)),
  )
})

describe("what the server says", () => {
  it.effect("its ready line and a failed backup", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readyToken('HUNTAWAY_READY {"port":7879,"token":"abc"}'), Option.some("abc"))
      assert.deepStrictEqual(yield* readyToken('HUNTAWAY_READY {"port":7879,"token":null}'), Option.some(null))
      assert.deepStrictEqual(yield* readyToken("listening on 127.0.0.1:7879"), Option.none())
      assert.deepStrictEqual(yield* readyToken("HUNTAWAY_READY {broken"), Option.none())
      // The old server's line is not this one's.
      assert.deepStrictEqual(yield* readyToken('IA_READY {"port":7878,"token":"abc"}'), Option.none())
      assert.deepStrictEqual(
        yield* backupFailure('HUNTAWAY_BACKUP_FAILED {"reason":"space","why":"full","dir":"/b"}'),
        Option.some({ reason: "space", why: "full", dir: "/b" }),
      )
    }),
  )

  it("only a refused connection means no server", () => {
    // As Node's fetch fails: a TypeError whose cause is the system error.
    assert.isTrue(refused({ _tag: "HttpClientError", reason: { cause: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }) } }))
    assert.isTrue(refused(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }])))
    assert.isFalse(refused({ cause: { code: "ECONNRESET" } }))
    assert.isFalse(refused({ cause: { code: "ETIMEDOUT" } }))
    assert.isFalse(refused(new Error("timed out")))
  })
})

describe("the windows' addresses", () => {
  it("only the board's pages are the board's; web links go to the browser; the pane shows web pages", () => {
    const board = "http://127.0.0.1:7879"
    assert.strictEqual(boardUrlPath(`${board}/profile/work?token=secret&x=1#top`, board), "/profile/work?x=1#top")
    assert.strictEqual(boardUrlPath(`${board}/api/health`, board), null)
    assert.strictEqual(boardUrlPath("https://example.com/", board), null)
    assert.strictEqual(boardUrlPath(`${board}/`, null), null)
    for (const url of ["http://x.invalid/", "https://x.invalid/", "mailto:a@b.invalid"]) assert.isTrue(isWebUrl(url))
    for (const url of ["file:///etc/passwd", "vscode://x", "javascript:alert(1)", "not a url"]) assert.isFalse(isWebUrl(url))
    assert.isFalse(isBrowsable("mailto:a@b.invalid"))
    assert.isTrue(isBrowsable("https://x.invalid/"))
  })

  it("a relaunch reopens the board pages it saved, else one window on the home page", () => {
    assert.deepStrictEqual(windowsToReopen(["/", "/profile/work", "https://evil.invalid/", 3]), ["/", "/profile/work"])
    assert.deepStrictEqual(windowsToReopen([]), ["/"])
    assert.deepStrictEqual(windowsToReopen(undefined), ["/"])
    assert.deepStrictEqual([badgeCount(3.7), badgeCount(-1), badgeCount("x"), badgeCount("4")], [3, 0, 0, 4])
  })

  it("desktop.json's fields are taken when they have the right type", () => {
    assert.deepStrictEqual(desktopFile({ port: 9000, dataDir: "~/d", serverUrl: 3, token: "t", skipDbBackup: true, host: "" }), {
      port: 9000,
      dataDir: "~/d",
      host: null,
      serverBin: null,
      serverUrl: null,
      token: "t",
      skipDbBackup: true,
    })
    assert.strictEqual(desktopFile([]).port, null)
  })
})

const decode = (url: string) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))

describe("the error page", () => {
  it("says what went wrong, escaped, with the server's last output, Retry and the config path", () => {
    const page = decode(errorPage({ message: "Server exited with code 1 <boom>", log: ["line one", "<script>"], configPath: "/c/desktop.json" }))
    assert.include(page, "Huntaway couldn't start")
    assert.include(page, "Server exited with code 1 &lt;boom>")
    assert.include(page, "&lt;script>")
    assert.include(page, RETRY_URL)
    assert.notInclude(page, SKIP_BACKUP_URL)
    assert.include(page, "/c/desktop.json")
  })

  it("for a backup that failed, why, the fix, and the way past it", () => {
    const page = decode(errorPage({ message: "x", backup: { reason: "space", why: "No space left", dir: "/b" }, log: [], configPath: "/c" }))
    assert.include(page, "Huntaway couldn't back up its database")
    assert.include(page, "Free some space on that disk (older backups in /b can go)")
    assert.include(page, SKIP_BACKUP_URL)
    assert.notInclude(page, "last output")
  })
})
