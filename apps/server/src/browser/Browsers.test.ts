import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Option, PubSub, Queue, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Socket } from "effect/socket"
import { CallId } from "@huntaway/contracts"
import { fakeAgent, fakeSocket, systemChrome, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeSocket } from "@huntaway/testing"
import { callResult } from "../mcp/jsonrpc.ts"
import { BROWSER_INSTRUCTIONS, McpServers } from "../mcp/McpServers.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Browsers } from "./Browsers.ts"
import { isRecord, jsonText, nextEvent, pageOf, str } from "./cdp.ts"
import { navigate } from "./page.ts"
import { startChrome } from "./chrome.ts"

// Each task's browser (HE-62) on the whole board, in this machine's Chromium (skipped where there's none): the
// `browser` server as a run calls it, a viewer's stream over a socket in memory, and the desktop app's pane, played by
// a second Chromium's page relayed over a socket as the app relays its <webview>'s debugger.

const PAGES: Readonly<Record<string, string>> = {
  "/": `<!doctype html><title>Form</title><h1>Sign up</h1><label>Name <input id="name"></label>
<button style="position:absolute;left:10px;top:200px;width:200px;height:60px" onclick="document.title = 'Hello ' + document.getElementById('name').value">Greet</button>
<a href="/second">Next page</a>`,
  "/second": "<!doctype html><title>Second</title><p>second page</p>",
  "/alert": `<!doctype html><title>Alerts</title><button onclick="alert('hi')">Alert</button><input id="field">`,
}

/** A web server of `PAGES` on a free port of 127.0.0.1, for as long as the scope lasts. */
const site = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
    const server = createServer((req, res) => {
      const body = PAGES[req.url ?? "/"]
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" }).end(body ?? "not found")
    })
    server.listen(0, "127.0.0.1", () => {
      const a = server.address()
      const port = typeof a === "object" && a !== null ? a.port : 0
      resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, close: () => server.close() }))
    })
  }),
  (s) => Effect.sync(() => s.close()),
)

/** The whole board with this machine's Chromium as the tasks' browser. */
const withBrowser = <A, E, R>(body: (url: string) => Effect.Effect<A, E, R>, chromeBin = systemChrome ?? "") =>
  Effect.scoped(Effect.flatMap(site, (s) => body(s.url))).pipe(
    Effect.provide(TestBoard({ chromeBin, chromeSandbox: false }).pipe(Layer.provideMerge(NodeServices.layer))),
  )

const Said = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String })

/** A call of the browser server's `tool` as `agent` makes it: its text, images and whether it's an error. */
const call = (agent: FakeAgent, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* callResult(yield* (yield* ToolCalls).call({ call_id: id, run: agent.run.id, server: "browser", tool, args }), "browser")
    if (!Schema.is(Said)(result)) return assert.fail("not a tool's result")
    const text = result.content
      .filter(Schema.is(TextPart))
      .map((c) => c.text)
      .join("\n")
    return { text, error: result.isError === true, images: result.content.filter(Schema.is(ImagePart)).map((c) => c.mimeType) }
  })

/** The ref of the outline's line that has `text`. */
const refOf = (outline: string, text: string) => {
  const line = outline.split("\n").find((l) => l.includes(text)) ?? assert.fail(`no ${text} in:\n${outline}`)
  return /\[ref=(e\d+)\]/u.exec(line)?.[1] ?? assert.fail(`no ref on: ${line}`)
}

/** The next frame the server sent that is JSON of `type` (binary frames and others are passed over). */
const nextJson = (sock: FakeSocket, type: string) =>
  Effect.gen(function* () {
    for (;;) {
      const f = yield* Queue.take(sock.sent)
      if (typeof f !== "string") continue
      const v: unknown = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(f).pipe(Option.getOrUndefined)
      if (isRecord(v) && v["type"] === type) return v
    }
  })

/** The next binary frame the server sent. */
const nextFrame = (sock: FakeSocket) =>
  Effect.gen(function* () {
    for (;;) {
      const f = yield* Queue.take(sock.sent)
      if (f instanceof Uint8Array) return f
    }
  })

const TIMEOUT = 60_000

const decodeCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Int, method: Schema.String, params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })),
)

describe.skipIf(systemChrome === null)("a task's browser", () => {
  it.live(
    "the browser server: its tools open the task's page, read it, act on it and show it",
    () =>
      withBrowser((url) =>
        Effect.gen(function* () {
          const servers = yield* McpServers
          assert.isTrue(yield* servers.serves("browser"))
          assert.strictEqual(servers.initializeResult("browser", "2025-06-18")["instructions"], BROWSER_INSTRUCTIONS)
          const agent = yield* fakeAgent()
          assert.deepStrictEqual(yield* (yield* Browsers).state(agent.run.task_id), null)

          const opened = yield* call(agent, "navigate", { url })
          assert.isFalse(opened.error, opened.text)
          assert.include(opened.text, `The page is now Form (${url}/)`)
          const outline = (yield* call(agent, "snapshot", {})).text
          assert.include(outline, '- button "Greet"')
          const typed = yield* call(agent, "type", { ref: refOf(outline, 'textbox "Name"'), text: "Ada" })
          assert.include(typed.text, "Typed 3 characters")
          assert.include((yield* call(agent, "click", { ref: refOf(outline, 'button "Greet"') })).text, "The page is now Hello Ada")
          assert.include((yield* call(agent, "click", { ref: refOf(outline, 'link "Next page"') })).text, `The page is now Second (${url}/second)`)
          // Back comes from the back/forward cache, as the page was.
          assert.include((yield* call(agent, "navigate", { go: "back" })).text, "The page is now Hello Ada")
          assert.deepStrictEqual(yield* call(agent, "evaluate", { expression: "1 + 1" }), { text: "2", error: false, images: [] })
          const shot = yield* call(agent, "screenshot", {})
          assert.deepStrictEqual(shot.images, ["image/png"])

          // What it can't do says so.
          assert.isTrue((yield* call(agent, "navigate", { url: "file:///etc/passwd" })).error)
          assert.include((yield* call(agent, "click", { ref: "e999999" })).text, "take a new snapshot")
          assert.include((yield* call(agent, "press", { key: "Hyper+q" })).text, "isn't a key")

          const state = yield* (yield* Browsers).state(agent.run.task_id)
          assert.deepStrictEqual([state?.backend, state?.url, state?.title], ["headless", `${url}/`, "Hello Ada"])
          assert.include((yield* call(agent, "close", {})).text, "Closed")
          assert.isNull(yield* (yield* Browsers).state(agent.run.task_id))
          // The next call opens it again where it was.
          assert.include((yield* call(agent, "snapshot", {})).text, `Form (${url}/)`)
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "a viewer gets the page as frames and its address and title as they change, and its clicks reach the page",
    () =>
      withBrowser((url) =>
        Effect.gen(function* () {
          const browsers = yield* Browsers
          const agent = yield* fakeAgent()
          const task = agent.run.task_id
          const sock = yield* fakeSocket
          const ticket = yield* browsers.ticket(task, "view")
          const viewer = yield* browsers.serve(ticket, { width: 640, height: 480, url }, Effect.succeed(sock.socket)).pipe(Effect.scoped, Effect.forkChild)
          assert.deepStrictEqual(yield* nextJson(sock, "viewport"), { type: "viewport", width: 640, height: 480 })
          const first = yield* nextFrame(sock)
          assert.deepStrictEqual([first[0], first[1]], [0xff, 0xd8])
          yield* sock.send('{"type":"ack"}')
          // The ticket was used.
          assert.strictEqual(
            (yield* Effect.flip(browsers.serve(ticket, { width: 1, height: 1, url: null }, Effect.succeed(sock.socket)).pipe(Effect.scoped)))._tag,
            "BrowserTicketInvalid",
          )

          // The agent types; the viewer clicks the button (in the middle of it) and sees the title change.
          const outline = (yield* call(agent, "snapshot", {})).text
          yield* call(agent, "type", { ref: refOf(outline, 'textbox "Name"'), text: "Bo" })
          for (const action of ["down", "up"]) {
            yield* sock.send(
              `{"type":"mouse","action":"${action}","x":110,"y":230,"button":"left","buttons":${action === "down" ? 1 : 0},"clickCount":1,"modifiers":0}`,
            )
          }
          yield* sock.send('{"type":"ack"}')

          for (;;) {
            const p = yield* nextJson(sock, "page")
            if (p["title"] === "Hello Bo") break
            yield* sock.send('{"type":"ack"}')
          }
          assert.strictEqual((yield* browsers.state(task))?.watching, 1)
          yield* sock.hangUp
          yield* Fiber.join(viewer)
          assert.strictEqual((yield* browsers.state(task))?.watching, 0)
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "the desktop app's pane takes the task's page: it loads where the agent was, viewers are told, and the agent drives it",
    () =>
      withBrowser((url) =>
        Effect.gen(function* () {
          const browsers = yield* Browsers
          const fs = yield* FileSystem.FileSystem
          const agent = yield* fakeAgent()
          const task = agent.run.task_id
          yield* call(agent, "navigate", { url: `${url}/second` })
          // A viewer of the headless page.
          const watcher = yield* fakeSocket
          const watching = yield* browsers
            .serve(yield* browsers.ticket(task, "view"), { width: 640, height: 480, url: null }, Effect.succeed(watcher.socket))
            .pipe(Effect.scoped, Effect.forkChild)
          yield* nextJson(watcher, "viewport")

          // The "desktop app": a page of another Chromium, whose session's commands and events go over the socket.
          const desk = yield* startChrome({ executable: systemChrome ?? "", profileDir: yield* fs.makeTempDirectoryScoped(), sandbox: false })
          const { targetId } = yield* desk.cdp.send("Target.createTarget", { url: "about:blank" })
          const sessionId = str(yield* desk.cdp.send("Target.attachToTarget", { targetId, flatten: true }), "sessionId")
          const pane = pageOf(desk.cdp, sessionId)
          yield* pane.send("Page.enable")
          yield* navigate(pane, `${url}/`)
          const loads = yield* pane.subscribe
          const sock = yield* fakeSocket
          const relay = Effect.gen(function* () {
            const sub = yield* desk.cdp.subscribe
            yield* PubSub.take(sub).pipe(
              Effect.flatMap((e) => (e.sessionId === sessionId ? sock.send(jsonText({ method: e.method, params: e.params })) : Effect.void)),
              Effect.forever,
              Effect.forkScoped,
            )
            for (;;) {
              const f = yield* Queue.take(sock.sent)
              if (typeof f !== "string") continue
              const m = Option.getOrThrow(decodeCommand(f))
              const answer = yield* pane.send(m.method, m.params ?? {}).pipe(Effect.result)
              yield* sock.send(
                jsonText(answer._tag === "Success" ? { id: m.id, result: answer.success } : { id: m.id, error: { message: answer.failure.reason } }),
              )
            }
          })
          yield* relay.pipe(Effect.forkScoped)
          const attached = yield* browsers
            .serve(yield* browsers.ticket(task, "desktop"), { width: 1, height: 1, url: null }, Effect.succeed(sock.socket))
            .pipe(Effect.scoped, Effect.forkChild)

          // The viewer is told, and the pane loads the page the agent was on.
          assert.deepStrictEqual(yield* nextJson(watcher, "desktop"), { type: "desktop" })
          yield* Fiber.join(watching)
          yield* nextEvent(pane, loads, (e) => e.method === "Page.loadEventFired", "15 seconds")
          const carried = yield* pane.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })
          assert.deepStrictEqual(carried["result"], { type: "string", value: "Second" })
          assert.strictEqual((yield* browsers.state(task))?.backend, "desktop")
          // The agent's tools act on the pane now.
          const went = yield* call(agent, "navigate", { url: `${url}/` })
          assert.include(went.text, "(in the user's desktop app, beside the thread)")
          const title = yield* pane.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })
          assert.deepStrictEqual(title["result"], { type: "string", value: "Form" })
          assert.include((yield* call(agent, "close", {})).text, "it's theirs to close")

          // Once the pane goes, the next call opens a headless page where the pane was.
          yield* sock.hangUp
          yield* Fiber.join(attached)
          const back = yield* call(agent, "snapshot", {})
          assert.include(back.text, `Form (${url}/)`)
          assert.strictEqual((yield* browsers.state(task))?.backend, "headless")
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "a viewer opens web pages only: not the host's files",
    () =>
      withBrowser(() =>
        Effect.gen(function* () {
          const browsers = yield* Browsers
          const agent = yield* fakeAgent()
          const task = agent.run.task_id
          const sock = yield* fakeSocket
          const ticket = yield* browsers.ticket(task, "view")
          // The start address is passed over, and the page opens blank.
          yield* browsers
            .serve(ticket, { width: 640, height: 480, url: "file:///etc/hostname" }, Effect.succeed(sock.socket))
            .pipe(Effect.scoped, Effect.forkChild)
          yield* nextJson(sock, "viewport")
          assert.strictEqual((yield* browsers.state(task))?.url, "about:blank")
          yield* sock.send('{"type":"navigate","url":"file:///etc/hostname"}')
          assert.include(str(yield* nextJson(sock, "error"), "message"), "isn't a web address")
          yield* sock.send('{"type":"navigate","url":"chrome://version"}')
          assert.include(str(yield* nextJson(sock, "error"), "message"), "isn't a web address")
          assert.strictEqual((yield* browsers.state(task))?.url, "about:blank")
          yield* sock.hangUp
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "a dialog the page shows is told to the agent once",
    () =>
      withBrowser((url) =>
        Effect.gen(function* () {
          const agent = yield* fakeAgent()
          yield* call(agent, "navigate", { url: `${url}/alert` })
          const outline = (yield* call(agent, "snapshot", {})).text
          const clicked = yield* call(agent, "click", { ref: refOf(outline, 'button "Alert"') })
          assert.include(clicked.text, "The page showed a dialog, which was accepted: alert: hi")
          const next = yield* call(agent, "type", { ref: refOf(outline, "textbox"), text: "x" })
          assert.notInclude(next.text, "dialog")
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "a viewer is let go when its page closes, and connects again to the new one",
    () =>
      withBrowser((url) =>
        Effect.gen(function* () {
          const browsers = yield* Browsers
          const agent = yield* fakeAgent()
          const task = agent.run.task_id
          yield* call(agent, "navigate", { url })
          const sock = yield* fakeSocket
          const viewer = yield* browsers
            .serve(yield* browsers.ticket(task, "view"), { width: 640, height: 480, url: null }, Effect.succeed(sock.socket))
            .pipe(Effect.scoped, Effect.forkChild)
          yield* nextFrame(sock)
          yield* call(agent, "close", {})
          // The socket closes as "service restart", and the relay ends.
          for (;;) {
            const f = yield* Queue.take(sock.sent)
            if (Socket.isCloseEvent(f)) {
              assert.strictEqual(f.code, 1012)
              break
            }
          }
          yield* Fiber.join(viewer)
          assert.strictEqual((yield* browsers.state(task))?.watching ?? 0, 0)
          // The agent opens the page again; a new viewer gets its frames.
          yield* call(agent, "navigate", { url: `${url}/second` })
          const again = yield* fakeSocket
          yield* browsers
            .serve(yield* browsers.ticket(task, "view"), { width: 640, height: 480, url: null }, Effect.succeed(again.socket))
            .pipe(Effect.scoped, Effect.forkChild)
          const frame = yield* nextFrame(again)
          assert.deepStrictEqual([frame[0], frame[1]], [0xff, 0xd8])
          assert.strictEqual((yield* browsers.state(task))?.title, "Second")
          yield* again.hangUp
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "a reap while Chrome is starting for a page leaves that Chrome alone",
    () =>
      Effect.gen(function* () {
        // A Chrome that says it has started (into one FIFO) and waits for the test (on another) before it runs.
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        execFileSync("mkfifo", [`${dir}/started`, `${dir}/go`])
        const bin = `${dir}/chrome`
        yield* fs.writeFileString(bin, `#!/bin/sh\necho started > ${dir}/started\nread line < ${dir}/go\nexec ${systemChrome ?? ""} "$@"\n`)
        yield* fs.chmod(bin, 0o755)
        return yield* withBrowser(
          (url) =>
            Effect.gen(function* () {
              const browsers = yield* Browsers
              const agent = yield* fakeAgent()
              const opening = yield* browsers.page(agent.run.task_id, url).pipe(Effect.forkChild)
              yield* fs.readFileString(`${dir}/started`)
              // The reap waits for the page being opened, then sees it.
              const reaping = yield* browsers.reap.pipe(Effect.forkChild)
              yield* fs.writeFileString(`${dir}/go`, "go\n")
              yield* Fiber.join(opening)
              yield* Fiber.join(reaping)
              assert.strictEqual((yield* browsers.state(agent.run.task_id))?.backend, "headless")
              assert.include((yield* call(agent, "snapshot", {})).text, "Form")
            }),
          bin,
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    TIMEOUT,
  )
})
