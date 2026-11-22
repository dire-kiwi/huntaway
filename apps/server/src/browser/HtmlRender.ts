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
import { navigate } from "./page.ts"
import { isRecord, num, str } from "./cdp.ts"
import type { CdpPage } from "./cdp.ts"
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
 * Reports the page's height to the wrapper, as the board's `fitFrame` (apps/web planTheme.ts) does: the body's extent,
 * when it loads, as the DOM changes and as anything in it changes size. Runs in the page's frame, as source.
 */
const FIT = `(() => {
  let last = -1
  const post = () => {
    const b = document.body
    if (!b) return
    const h = Math.max(b.scrollHeight, Math.ceil(b.getBoundingClientRect().height))
    if (h === last) return
    last = h
    parent.postMessage({ iaHtmlHeight: h }, "*")
  }
  const sizes = new ResizeObserver(post)
  addEventListener("DOMContentLoaded", () => {
    sizes.observe(document.body)
    for (const e of document.body.querySelectorAll("*")) sizes.observe(e)
    new MutationObserver(post).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    post()
  })
  for (const t of ["load", "transitionend", "animationend"]) addEventListener(t, post)
})()`

/**
 * Tells the wrapper what the page says on its console (iaConsole), before anything of the page's runs: its console
 * calls, uncaught errors and rejections, what its policy refuses, and its dialogs (which the thread's frame, with no
 * allow-modals, ignores). Read here rather than over the DevTools protocol, as Chrome runs a sandboxed frame in a
 * process of its own, and following that one (`Target.setAutoAttach`) crashed CI's Chromium. Runs in the page's frame.
 */
const CONSOLE = `(() => {
  const send = (level, text) => parent.postMessage({ iaConsole: [level, String(text)] }, "*")
  const show = (v) => {
    if (typeof v === "string") return v
    if (v instanceof Error) return String(v)
    try { const j = JSON.stringify(v); return j === undefined ? String(v) : j } catch { return String(v) }
  }
  for (const [name, level] of [["log", "log"], ["debug", "log"], ["info", "info"], ["warn", "warning"], ["error", "error"]]) {
    const own = console[name]
    console[name] = (...args) => (send(level, args.map(show).join(" ")), own.apply(console, args))
  }
  addEventListener("error", (e) => send("exception", (e.error ? String(e.error) : e.message) + " (line " + e.lineno + ")"))
  addEventListener("unhandledrejection", (e) => send("exception", "Uncaught (in promise) " + show(e.reason)))
  addEventListener("securitypolicyviolation", (e) => send("error", "The page's policy refused " + (e.blockedURI || "an inline " + e.effectiveDirective) + " (" + e.effectiveDirective + ")"))
  for (const d of ["alert", "confirm", "prompt"])
    window[d] = (m) => (send("warning", "The page opened a dialog (" + d + ": " + (m ?? "") + "), which the thread's frame ignores."), d === "confirm" ? false : null)
})()`

/**
 * The wrapper's policy: only that. A srcdoc frame inherits its parent's policy, so anything more would hold the page to
 * it too (its data: images, the CDNs' scripts, eval), which the board's doesn't.
 */
const WRAPPER_CSP = "frame-src 'none'"

/** Where the preview loads the wrapper from: an address nothing else answers (`.invalid`), which the preview does. */
const PREVIEW_URL = "https://preview.huntaway.invalid/"

/** `value` as a double-quoted attribute's value. */
const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

/**
 * The preview's document, which holds the page as the board's thread does (thread/htmlPage.tsx): the page in a
 * sandboxed frame (srcdoc, `allow-scripts allow-forms`: its own opaque origin, no popups, no navigating the top, no
 * dialogs), under the documents' policy, with the theme first. The wrapper's own policy holds the frame's navigations
 * (`frame-src 'none'`, as the board's `frame-src 'self'` does), so a page can't make the host's Chrome load another
 * address (with its profile's cookies, or one on this machine) and screenshot it. The wrapper takes the height the page
 * reports (`iaHeight`) and sizes the frame to it, and keeps what it says on its console (`iaConsole`). Trusted Types aren't required in the page: in the board a default
 * policy that lets every string through goes with them (to keep a javascript: frame from WebRTC), so its innerHTML
 * works the same.
 */
export const previewDocument = (html: string): string => {
  const csp = FRAME_CSP.split("; ")
    .filter((d) => !d.startsWith("require-trusted-types-for"))
    .join("; ")
  const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${CONSOLE}</script>${htmlRenderPage(html)}\n<script>${FIT}</script>`
  const wrapper = WRAPPER_CSP
  const take =
    `window.iaConsole = []; addEventListener('message', (e) => { const f = document.querySelector('iframe'); if (!f || e.source !== f.contentWindow) return; ` +
    "if (typeof e.data?.iaHtmlHeight === 'number') { window.iaHeight = e.data.iaHtmlHeight; f.style.height = e.data.iaHtmlHeight + 'px' } " +
    `else if (Array.isArray(e.data?.iaConsole) && window.iaConsole.length < ${MAX_MESSAGES}) window.iaConsole.push(e.data.iaConsole) })`
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${wrapper}">` +
    "<style>html,body{margin:0;background:transparent}iframe{display:block;border:0;width:100%;height:40px}</style>" +
    `<script>${take}</script>` +
    `<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" srcdoc="${attribute(page)}"></iframe>`
  )
}

/**
 * Waits for the wrapper's load (its frame's included), the page's height and two frames after, then a beat for what the
 * page logs as it starts (a worker's answer, say), within 10 seconds.
 */
const SETTLE = `new Promise((done) => {
  const late = setTimeout(() => done(false), 10000)
  const settle = () => {
    const tries = Date.now() + 2000
    const wait = () => (window.iaHeight !== undefined || Date.now() > tries ? requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => (clearTimeout(late), done(true)), 200))) : setTimeout(wait, 50))
    wait()
  }
  if (document.readyState === "complete") settle()
  else addEventListener("load", settle, { once: true })
})`

/** The page's height as it reported it (the board's frame takes the same). */
const HEIGHT = "window.iaHeight ?? 0"

/** The page's console, as it told the wrapper. */
const CONSOLE_SAID = "window.iaConsole ?? []"

/** A console line from what the page told the wrapper (`[level, text]`). */
export const consoleLine = (entry: unknown): string | null => {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") return null
  const line = `[${entry[0]}] ${entry[1]}`
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line
}

const BOARD_BACKGROUND = { r: 11, g: 11, b: 14, a: 1 }

/** Loads `html` in `page` at `width`: its height, its console and a screenshot (base64 PNG). */
const previewOn = (page: CdpPage, html: string, width: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sub = yield* page.subscribe
      const dialogs: Array<string> = []
      const body = Base64.encode(new TextEncoder().encode(previewDocument(html)))
      // The page's dialogs are its frame's, which ignores them (CONSOLE says so); one on the wrapper, should anything get
      // one up, is dismissed rather than left holding the page.
      yield* PubSub.take(sub).pipe(
        Effect.flatMap((e) => {
          if (e.sessionId !== page.sessionId) return Effect.void
          if (e.method === "Fetch.requestPaused") {
            const requestId = str(e.params, "requestId")
            const url = isRecord(e.params["request"]) ? str(e.params["request"], "url") : ""
            // The wrapper; anything else at its address (a favicon) isn't there.
            return (
              url === PREVIEW_URL
                ? page.send("Fetch.fulfillRequest", {
                    requestId,
                    responseCode: 200,
                    responseHeaders: [
                      { name: "Content-Type", value: "text/html; charset=utf-8" },
                      { name: "Content-Security-Policy", value: WRAPPER_CSP },
                    ],
                    body,
                  })
                : page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
            ).pipe(Effect.ignore)
          }
          if (e.method !== "Page.javascriptDialogOpening") return Effect.void
          dialogs.push(`[warning] A dialog was dismissed (${str(e.params, "type")}: ${str(e.params, "message")}).`)
          return page.send("Page.handleJavaScriptDialog", { accept: false }).pipe(Effect.ignore)
        }),
        Effect.forever,
        Effect.forkScoped,
      )
      yield* page.send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false })
      yield* page.send("Emulation.setDefaultBackgroundColorOverride", { color: BOARD_BACKGROUND })
      // The wrapper is loaded from an address of its own (PREVIEW_URL), answered here, rather than written into the
      // page's about:blank (`Page.setDocumentContent`): that document has no site, and Chrome can't place the sandboxed
      // frame's process beside it (CI's Chromium failed `has_site_` in site_instance_impl.cc and aborted).
      yield* page.send("Fetch.enable", { patterns: [{ urlPattern: `${PREVIEW_URL}*`, requestStage: "Request" }] })
      yield* navigate(page, PREVIEW_URL)
      const settled = yield* page.send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true, returnByValue: true }, "15 seconds")
      const measured = yield* page.send("Runtime.evaluate", { expression: HEIGHT, returnByValue: true })
      const height = isRecord(measured["result"]) ? Math.max(0, Math.ceil(num(measured["result"], "value"))) : 0
      const logged = yield* page.send("Runtime.evaluate", { expression: CONSOLE_SAID, returnByValue: true })
      const entries = isRecord(logged["result"]) && Array.isArray(logged["result"]["value"]) ? logged["result"]["value"] : []
      const shot = Math.max(1, Math.min(height, MAX_SHOT_HEIGHT))
      const png = str(
        yield* page.send(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: shot, scale: 1 } },
          "20 seconds",
        ),
        "data",
      )
      const said = [...entries.flatMap((entry: unknown) => consoleLine(entry) ?? []), ...dialogs].slice(0, MAX_MESSAGES)
      const late = isRecord(settled["result"]) && settled["result"]["value"] === false
      return { height, shot, png, console: said, late }
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
