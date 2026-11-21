import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { str } from "./cdp.ts"
import { splitMessages, startChrome } from "./chrome.ts"
import { systemChrome } from "@huntaway/testing"

describe("splitMessages", () => {
  it.effect("cuts the pipe's text at each NUL, keeping a message split across chunks whole", () =>
    Effect.gen(function* () {
      const out = yield* splitMessages(Stream.make('{"a":1}\0{"b"', ':2}\0{"c":3}', "\0")).pipe(Stream.runCollect)
      assert.deepStrictEqual(out, ['{"a":1}', '{"b":2}', '{"c":3}'])
    }),
  )
})

describe.skipIf(systemChrome === null)("startChrome", () => {
  it.live("speaks CDP over the pipe: makes a page, loads it, reads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const profileDir = yield* fs.makeTempDirectoryScoped()
        const chrome = yield* startChrome({ executable: systemChrome ?? "", profileDir, sandbox: false, proxy: null })
        const version = yield* chrome.cdp.send("Browser.getVersion")
        assert.include(str(version, "product"), "Chrome")
        const { targetId } = yield* chrome.cdp.send("Target.createTarget", { url: "about:blank" })
        const attached = yield* chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true })
        const sessionId = str(attached, "sessionId")
        yield* chrome.cdp.send("Page.navigate", { url: "data:text/html,<title>Hi</title><p>there</p>" }, sessionId)
        const r = yield* chrome.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)
        assert.deepStrictEqual(r["result"], { type: "string", value: "Hi" })
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live("a program that isn't there fails its commands with why", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chrome = yield* startChrome({ executable: "/nonexistent/chrome", profileDir: "/tmp", sandbox: false, proxy: null })
        const r = yield* Effect.flip(chrome.cdp.send("Browser.getVersion"))
        assert.include(r.reason, "Chrome")
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
