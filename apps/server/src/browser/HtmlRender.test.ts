import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { SecureRandom } from "effect/crypto"
import { CallId } from "@huntaway/contracts"
import { fakeAgent, systemChrome, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { htmlRenderAttachment } from "@huntaway/shared"
import { callResult } from "../mcp/jsonrpc.ts"
import { McpServers } from "../mcp/McpServers.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Attachments } from "../tasks/Attachments.ts"
import { SHOWN } from "./HtmlRender.ts"

// HE-78: html_render and html_preview on the whole board, as a run calls them on the board's own server; the preview
// in this machine's Chromium (skipped where there's none).

const board = (chromeBin = systemChrome ?? "") => TestBoard({ chromeBin, chromeSandbox: false }).pipe(Layer.provideMerge(NodeServices.layer))

const Said = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String })

const call = (agent: FakeAgent, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* callResult(yield* (yield* ToolCalls).call({ call_id: id, run: agent.run.id, server: "huntaway", tool, args }), "huntaway")
    if (!Schema.is(Said)(result)) return assert.fail("not a tool's result")
    const text = result.content
      .filter(Schema.is(TextPart))
      .map((c) => c.text)
      .join("\n")
    return { text, error: result.isError === true, images: result.content.filter(Schema.is(ImagePart)) }
  })

/** A 1×1 PNG. */
const PNG = Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

describe("html_render", () => {
  it.live("keeps the page as an attachment with its local images put in, and its answer names it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      if (PNG._tag === "Failure") return assert.fail("the PNG")
      yield* fs.writeFile(`${dir}/shot.png`, PNG.success)
      const agent = yield* fakeAgent()
      const listed = (yield* (yield* McpServers).tools("huntaway", false)).map((t) => t.name)
      assert.includeMembers(listed, ["html_preview", "html_render"])

      const said = yield* call(agent, "html_render", { title: "Shots", html: `<h2>Shots</h2><img src="${dir}/shot.png">`, height: 120 })
      assert.isFalse(said.error, said.text)
      assert.include(said.text, SHOWN)
      const kept = htmlRenderAttachment(said.text) ?? assert.fail(`no attachment in: ${said.text}`)
      assert.strictEqual(kept.name, "Shots.html")
      const file = yield* (yield* Attachments).get(kept.id, kept.name)
      const page = new TextDecoder().decode(Base64.decode(file.data).pipe((r) => (r._tag === "Success" ? r.success : new Uint8Array())))
      assert.include(page, '<img src="data:image/png;base64,iVBORw0KGgo')
      assert.notInclude(page, dir)
    }).pipe(Effect.scoped, Effect.provide(board())),
  )

  it.live("refuses a page sized to the viewport, and one whose images aren't images", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/key.png`, "-----BEGIN OPENSSH PRIVATE KEY-----")
      const agent = yield* fakeAgent()
      const tall = yield* call(agent, "html_render", { title: "Tall", html: "<style>main{height:100vh}</style><main>x</main>" })
      assert.isTrue(tall.error)
      assert.include(tall.text, "viewport height unit (100vh)")
      const key = yield* call(agent, "html_render", { title: "Key", html: `<img src="${dir}/key.png"><img src="${dir}/gone.png">` })
      assert.isTrue(key.error)
      assert.include(key.text, `${dir}/key.png, ${dir}/gone.png`)
    }).pipe(Effect.scoped, Effect.provide(board())),
  )
})

describe.skipIf(systemChrome === null)("html_preview", () => {
  it.live(
    "loads the page in the theme, and says its height and console with a screenshot",
    () =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        const html =
          '<div style="height:300px;background:var(--panel)">x</div>' +
          "<script>console.log('bg', getComputedStyle(document.documentElement).getPropertyValue('--bg')); console.warn('careful'); undefinedThing()</script>" +
          '<img style="position:absolute;top:0" src="https://example.com/remote.png">'
        const said = yield* call(agent, "html_preview", { html, width: 400 })
        assert.isFalse(said.error, said.text)
        assert.strictEqual(said.images.length, 1)
        assert.strictEqual(said.images[0]?.mimeType, "image/png")
        assert.include(said.text, "Width 400px; the page is 300px tall")
        assert.include(said.text, "[log] bg #0b0b0e")
        assert.include(said.text, "[warning] careful")
        assert.match(said.text, /\[exception\] ReferenceError: undefinedThing is not defined/)
        // The board's policy holds in the preview: a remote image doesn't load, and the agent is told.
        assert.match(said.text, /\[error\] .*remote\.png/)
        const tall = yield* call(agent, "html_preview", { html: "<div style='height:50svh'></div>" })
        assert.isTrue(tall.error)
      }).pipe(Effect.provide(board())),
    60_000,
  )
})
