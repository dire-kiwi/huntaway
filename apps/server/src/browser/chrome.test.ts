import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Stream } from "effect"
import { nextEvent, pageOf, str } from "./cdp.ts"
import { lastSaid, splitMessages, startChrome } from "./chrome.ts"
import { systemChrome } from "@huntaway/testing"

describe("splitMessages", () => {
  it.effect("cuts the pipe's text at each NUL, keeping a message split across chunks whole", () =>
    Effect.gen(function* () {
      const out = yield* splitMessages(Stream.make('{"a":1}\0{"b"', ':2}\0{"c":3}', "\0")).pipe(Stream.runCollect)
      assert.deepStrictEqual(out, ['{"a":1}', '{"b":2}', '{"c":3}'])
    }),
  )
})

/** What Chrome writes when it finds no D-Bus session. */
const dbus = (n: number) =>
  `[13085:${n}:1121/063720.998639:ERROR:dbus/bus.cc:406] Failed to connect to the bus: Could not parse server address: Unknown address type`

describe("lastSaid", () => {
  it("keeps Chrome's last three lines, less its complaints that there's no D-Bus", () => {
    const said = ["first", "[1:2:1121/0.1:ERROR:content/a.cc:1] second", dbus(1), "", "  third  ", dbus(2), "[1:2:1121/0.1:ERROR:dbus/object_proxy.cc:572] x"]
    assert.strictEqual(lastSaid(said.join("\n")), "first / [1:2:1121/0.1:ERROR:content/a.cc:1] second / third")
    assert.strictEqual(lastSaid(dbus(3)), "")
  })

  it("names the line a crash's report starts with, before its last lines (HE-78)", () => {
    const crash = [
      "Received signal 11 SEGV_MAPERR 000000000010",
      "#0 0x55 base::debug::CollectStackTrace()",
      "r8: 0 r9: 0",
      "ip: 7d2e efl: 246",
      "[end of stack trace]",
    ]
    assert.strictEqual(lastSaid(crash.join("\n")), "Received signal 11 SEGV_MAPERR 000000000010 / r8: 0 r9: 0 / ip: 7d2e efl: 246 / [end of stack trace]")
  })
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
        // Page.navigate answers before the new document has loaded (HE-121): its load is waited for.
        const events = yield* chrome.cdp.subscribe
        yield* chrome.cdp.send("Page.enable", {}, sessionId)
        yield* chrome.cdp.send("Page.navigate", { url: "data:text/html,<title>Hi</title><p>there</p>" }, sessionId)
        const loaded = yield* nextEvent(pageOf(chrome.cdp, sessionId), events, (e) => e.method === "Page.loadEventFired", "15 seconds")
        assert.isTrue(Option.isSome(loaded), "the page loaded")
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
