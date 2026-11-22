import { Effect, FileSystem, Option, PubSub, Stream } from "effect"
import { Base64 } from "effect/encoding"
import {
  FRAME_CSP,
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderPage,
  imageType,
  inlineImages,
  isImageBytes,
  localImages,
  viewportHeightUnit,
} from "@huntaway/shared"
import { text } from "../desktop/cua.ts"
import { localToolHandler, McpServers } from "../mcp/McpServers.ts"
import { BOARD_SERVER, boardContent } from "../mcp/tool.ts"
import { Attachments, MAX_BYTES } from "../tasks/Attachments.ts"
import { Browsers } from "./Browsers.ts"
import { isRecord, jsonText, num, str } from "./cdp.ts"
import type { CdpEvent, CdpPage } from "./cdp.ts"
import { HtmlPreview, HtmlRender } from "./renderTools.ts"

// HE-78: the handlers of `html_render` and `html_preview` (renderTools.ts; docs/plan/07-agents.md, HTML pages in the
// thread). A page is made ready the same way for both: one with a viewport height unit is refused, and the local images
// it names by absolute path are put in as data: URIs (only files whose bytes are an image). `html_render` keeps it as an
// attachment, which its answer names: the thread shows the page from there (the web's thread/htmlPage.tsx), and keeps
// it while the thread refers to it. `html_preview` loads it in a page of its own in the headless Chrome
// (`Browsers.scratch`), under the policy and theme the board shows it with.

/** The largest local image put in a page. */
export const MAX_IMAGE_BYTES = 5 << 20

/** The page ready to keep or load, and the images it names that couldn't be put in. */
interface Prepared {
  readonly html: string
  readonly missing: ReadonlyArray<string>
}

/** Why a page can't be kept or loaded, as the agent is told. */
type Refusal = string

const MIB = (n: number) => `${(n / (1 << 20)).toFixed(1)} MiB`

/** The local image at `path`, as a data: URI, or why it can't be. */
const readImage = (fs: FileSystem.FileSystem, path: string): Effect.Effect<Option.Option<string>, Refusal> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(path).pipe(Effect.option)
    if (Option.isNone(info) || info.value.type !== "File") return Option.none()
    if (Number(info.value.size) > MAX_IMAGE_BYTES)
      return yield* Effect.fail(`${path} is ${MIB(Number(info.value.size))}; each image may be at most ${MIB(MAX_IMAGE_BYTES)}.`)
    // A file can grow after its `stat`: no more than one byte past the limit is read.
    const bytes = yield* fs.stream(path, { bytesToRead: MAX_IMAGE_BYTES + 1 }).pipe(Stream.mkUint8Array, Effect.option)
    if (Option.isNone(bytes) || !isImageBytes(bytes.value)) return Option.none()
    if (bytes.value.length > MAX_IMAGE_BYTES) return yield* Effect.fail(`${path} is larger than ${MIB(MAX_IMAGE_BYTES)}.`)
    return Option.some(`data:${imageType(path)};base64,${Base64.encode(bytes.value)}`)
  })

/** `html` ready to keep or show: refused if it sizes itself to the viewport, its local images put in. */
export const preparePage = (fs: FileSystem.FileSystem, html: string): Effect.Effect<Prepared, Refusal> =>
  Effect.gen(function* () {
    const unit = viewportHeightUnit(html)
    if (unit !== null)
      return yield* Effect.fail(
        `The page uses a viewport height unit (${unit}). Its frame grows to fit the page, so a size that follows the viewport grows it again and again: let the content set the height, or use fixed pixel heights.`,
      )
    const images = localImages(html)
    const paths = [...new Set(images.map((i) => i.path))]
    const read = yield* Effect.forEach(paths, (path) => Effect.map(readImage(fs, path), (uri) => [path, uri] as const), { concurrency: 4 })
    const uris = new Map(read.flatMap(([path, uri]) => (Option.isSome(uri) ? [[path, uri.value] as const] : [])))
    const page = inlineImages(html, images, uris)
    const size = new TextEncoder().encode(page).length
    if (size > MAX_BYTES) return yield* Effect.fail(`With its images put in, the page is ${MIB(size)}; the most is ${MIB(MAX_BYTES)}. Use smaller images.`)
    return { html: page, missing: paths.filter((p) => !uris.has(p)) }
  })

/** What `html_render` tells the agent once the page is up. */
export const SHOWN =
  "The user sees the page in your thread, in place of this call. Don't mention, point to or describe it in your reply: add only what it doesn't already say."

// ---- the preview ----------------------------------------------------------------------------------------------------

const MIN_WIDTH = 240
const MAX_WIDTH = 1600
/** The tallest screenshot: the rest of a longer page is cut off (its height says how much). */
const MAX_SHOT_HEIGHT = 4000
const MAX_MESSAGES = 60
const MAX_MESSAGE = 600

/**
 * The page as a preview loads it: the board's frame policy first, then the theme, then the page. Trusted Types aren't
 * required here: in the board, a default policy that lets every string through goes with them (to keep a javascript:
 * frame from WebRTC, which isn't a preview's concern), so the page's innerHTML works there as it does here.
 */
export const previewDocument = (html: string): string => {
  const csp = FRAME_CSP.split("; ")
    .filter((d) => !d.startsWith("require-trusted-types-for"))
    .join("; ")
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${htmlRenderPage(html)}`
}

/** Waits for the page's load, its fonts and two frames after, within 10 seconds. */
const SETTLE = `new Promise((done) => {
  const late = setTimeout(() => done(false), 10000)
  const settle = () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(late), done(true)))))
  if (document.readyState === "complete") settle()
  else addEventListener("load", settle, { once: true })
})`

/** The page's height as the board's frame takes it (the body's extent: planTheme.ts' `fitFrame`). */
const HEIGHT = "document.body ? Math.max(document.body.scrollHeight, Math.ceil(document.body.getBoundingClientRect().height)) : 0"

/** What a console call's arguments say. */
const argsText = (args: unknown): string =>
  (Array.isArray(args) ? args : [])
    .map((a: unknown) => {
      if (!isRecord(a)) return ""
      if (a["value"] !== undefined) return typeof a["value"] === "string" ? a["value"] : jsonText(a["value"])
      return str(a, "description") || str(a, "type")
    })
    .join(" ")

/** A console line of an event of the page's, if it's one. */
export const consoleLine = (e: CdpEvent): string | null => {
  switch (e.method) {
    case "Runtime.consoleAPICalled": {
      const type = str(e.params, "type")
      const level = type === "warning" ? "warning" : type === "error" || type === "assert" ? "error" : type === "info" ? "info" : "log"
      return `[${level}] ${argsText(e.params["args"])}`
    }
    case "Runtime.exceptionThrown": {
      const d = isRecord(e.params["exceptionDetails"]) ? e.params["exceptionDetails"] : {}
      const ex = isRecord(d["exception"]) ? str(d["exception"], "description") : ""
      return `[exception] ${ex || str(d, "text")} (line ${num(d, "lineNumber") + 1})`
    }
    case "Log.entryAdded": {
      const entry = isRecord(e.params["entry"]) ? e.params["entry"] : {}
      const level = str(entry, "level")
      return level === "error" || level === "warning" ? `[${level}] ${str(entry, "text")}` : null
    }
    default:
      return null
  }
}

const BOARD_BACKGROUND = { r: 11, g: 11, b: 14, a: 1 }

/** Loads `html` in `page` at `width`: its height, its console and a screenshot (base64 PNG). */
const previewOn = (page: CdpPage, html: string, width: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sub = yield* page.subscribe
      const said: Array<string> = []
      yield* PubSub.take(sub).pipe(
        Effect.map((e) => {
          const line = e.sessionId === page.sessionId ? consoleLine(e) : null
          if (line !== null && said.length < MAX_MESSAGES) said.push(line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line)
        }),
        Effect.forever,
        Effect.forkScoped,
      )
      yield* page.send("Log.enable")
      yield* page.send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false })
      yield* page.send("Emulation.setDefaultBackgroundColorOverride", { color: BOARD_BACKGROUND })
      const tree = yield* page.send("Page.getFrameTree")
      const frame = isRecord(tree["frameTree"]) && isRecord(tree["frameTree"]["frame"]) ? str(tree["frameTree"]["frame"], "id") : ""
      yield* page.send("Page.setDocumentContent", { frameId: frame, html: previewDocument(html) })
      const settled = yield* page.send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true, returnByValue: true }, "15 seconds")
      const measured = yield* page.send("Runtime.evaluate", { expression: HEIGHT, returnByValue: true })
      const height = isRecord(measured["result"]) ? Math.max(0, Math.ceil(num(measured["result"], "value"))) : 0
      const shot = Math.max(1, Math.min(height, MAX_SHOT_HEIGHT))
      const png = str(
        yield* page.send(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: shot, scale: 1 } },
          "20 seconds",
        ),
        "data",
      )
      const late = isRecord(settled["result"]) && settled["result"]["value"] === false
      return { height, shot, png, console: [...said], late }
    }),
  )

/** What the preview tells the agent besides its screenshot. */
export const previewSays = (p: {
  readonly width: number
  readonly height: number
  readonly shot: number
  readonly console: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly late: boolean
}): string =>
  [
    `Width ${p.width}px; the page is ${p.height}px tall at this width (the frame's height).` +
      (p.height > p.shot ? ` The screenshot shows its first ${p.shot}px.` : ""),
    p.late ? "The page hadn't finished loading after 10 seconds: the screenshot is of it then." : null,
    p.missing.length > 0 ? `These images couldn't be read as images, so they aren't in the page: ${p.missing.join(", ")}` : null,
    p.console.length > 0 ? `Console:\n${p.console.join("\n")}` : "Nothing in the console.",
  ]
    .filter((l) => l !== null)
    .join("\n")

// ---- the tools ------------------------------------------------------------------------------------------------------

export const htmlTools = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const attachments = yield* Attachments
  const browsers = yield* Browsers

  const render = localToolHandler(HtmlRender, (a) =>
    Effect.gen(function* () {
      const page = yield* preparePage(fs, a.html)
      if (page.missing.length > 0)
        return yield* Effect.fail(
          `These local images couldn't be read as images: ${page.missing.join(", ")}. Give absolute paths to image files, or leave them out.`,
        )
      const kept = yield* attachments.save(htmlRenderFileName(a.title), new TextEncoder().encode(page.html)).pipe(Effect.mapError((e) => e.reason))
      // The path is how the thread finds the page (`htmlRenderAttachment`), and what keeps it.
      return boardContent(text(`${SHOWN}\n(Kept as ${kept.path}.)`))
    }).pipe(Effect.catch((reason: string) => Effect.succeed(boardContent(text(reason, true))))),
  )

  const preview = localToolHandler(HtmlPreview, (a) =>
    Effect.gen(function* () {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, a.width ?? HTML_RENDER_COLUMN_WIDTH))
      const page = yield* preparePage(fs, a.html)
      const shown = yield* browsers.scratch((p) => previewOn(p, page.html, width)).pipe(Effect.mapError((e) => `The preview failed: ${e.reason}`))
      return boardContent({
        content: [
          { type: "image", data: shown.png, mimeType: "image/png" },
          { type: "text", text: previewSays({ width, ...shown, missing: page.missing }) },
        ],
      })
    }).pipe(Effect.catch((reason: string) => Effect.succeed(boardContent(text(reason, true))))),
  )

  return [preview, render]
})

/** The two tools, on the board's own server (`Main.ts`, with the browser area's, whose Chrome the previews use). */
export const HtmlTools = McpServers.register(BOARD_SERVER, htmlTools)
