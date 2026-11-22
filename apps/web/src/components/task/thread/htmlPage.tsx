import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Download, Loader2, Maximize2, Minus, Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { FRAME_CSP, HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT, HTML_RENDER_THEME, htmlRenderAttachment, htmlRenderPage } from "@huntaway/shared"
import { download, IconButton, OpenLinkBar, resultError, resultValue } from "../../ui"
import { attachmentTextAtom } from "../attachmentFiles"
import { followsFrameInput, fromFrame, linksInNewTabs, noWebRtc, openable, trackBoardInput } from "../htmlFrame"
import { fitFrame } from "../planTheme"
import { numberOf, fieldsOf, stringOf } from "./fields"
import type { Call } from "./threadModel"
import { ToolGroup } from "./tools"

// HE-78: an agent's HTML page in the thread (its `html_render` call; docs/plan/09-frontend.md, HTML pages in the thread),
// after T3 Code's. The page is the attachment the call's answer names, shown in place of the call in a sandboxed frame
// (scripts in an origin of their own, under the documents' policy, FRAME_CSP) as wide as the reply column and as tall as
// the page says it is (`fitFrame`), in the board's theme (the profile's tint included). Its links ask the board, as a
// document's do (`linksInNewTabs`). It opens full screen, with zoom, and downloads as the page it is.

/** The board's colours the page's theme takes, from index.css's `@theme` as the tint leaves them (theme.ts). */
const BOARD_COLOURS = ["bg", "panel", "panel-2", "raised", "line", "line-strong", "fg", "muted", "faint", "accent"]

/** The page's theme: the stock one, with the board's colours as they are now. */
const liveTheme = (): Readonly<Record<string, string>> => {
  const style = getComputedStyle(document.documentElement)
  const own = BOARD_COLOURS.flatMap((c) => {
    const v = style.getPropertyValue(`--color-${c}`).trim()
    return v === "" ? [] : [[`--${c}`, v] as const]
  })
  const accent = own.find(([k]) => k === "--accent")?.[1]
  return { ...HTML_RENDER_THEME, ...Object.fromEntries(own), ...(accent === undefined ? {} : { "--chart-1": accent }) }
}

/**
 * Passes Escape on to the board (iaKey), unless the page took it: the frame is of another origin, so a key pressed while
 * it has the focus never reaches the board's own listeners, and Escape is how the full-screen view closes. The page's
 * own listeners on the window run first (they were added before this). It runs in the page's frame, as source.
 */
function escapeToBoard() {
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) parent.postMessage({ iaKey: "Escape" }, "*")
  })
}

/** The frame's document: the policy and `noWebRtc` before anything of the page's, then the theme, the page, and the board's scripts. */
export const pageDocument = (html: string, theme: Readonly<Record<string, string>>) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>(${String(noWebRtc)})()</script>\n${htmlRenderPage(html, theme)}\n<script>(${String(fitFrame)})();(${String(linksInNewTabs)})();(${String(escapeToBoard)})()</script>`

const clampHeight = (h: number) => Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(h)))

/** The `html_render` call's row: the page once it's kept; the call as a tool row while it runs or if it failed. */
export function HtmlPageRow({ call, running, hostId, cwd }: { call: Call; running: boolean; hostId: string; cwd?: string | null | undefined }) {
  const kept = call.result && !call.result.isError ? htmlRenderAttachment(call.result.content) : null
  if (kept === null) return <ToolGroup calls={[call]} running={running} cwd={cwd} />
  const input = fieldsOf(call.input)
  return <HtmlPage hostId={hostId} file={kept} title={stringOf(input.title) ?? "Page"} height={numberOf(input.height)} />
}

function HtmlPage({
  hostId,
  file,
  title,
  height,
}: {
  hostId: string
  file: { readonly id: string; readonly name: string }
  title: string
  height: number | undefined
}) {
  const result = useAtomValue(attachmentTextAtom(hostId, file))
  const html = resultValue(result)
  const [full, setFull] = useState(false)
  const [asked, setAsked] = useState<string | null>(null)
  if (resultError(result) !== null)
    return <div className="rounded-lg border border-dashed border-line px-3 py-2 text-[12.5px] text-muted">The page “{title}” isn't there any more.</div>
  if (html === undefined)
    return (
      <div className="flex items-center gap-2 px-2 text-[12.5px] text-faint" style={{ height: height === undefined ? 40 : clampHeight(height) }}>
        <Loader2 size={12} className="animate-spin" /> {title}
      </div>
    )
  return (
    <div data-html-page className="group/page relative">
      {/* While full screen is open, its own bar asks (the page asked from there, and this one is under it). */}
      {asked && !full && (
        <div className="mb-1 overflow-hidden rounded-md">
          <OpenLinkBar what="page" url={asked} onDone={() => setAsked(null)} />
        </div>
      )}
      <PageFrame html={html} title={title} initialHeight={height} onAsk={setAsked} />
      <div className="absolute top-1 right-1 flex gap-0.5 rounded-md bg-panel/90 opacity-0 shadow transition-opacity group-hover/page:opacity-100 focus-within:opacity-100 narrow:opacity-100 [@media(hover:none)]:opacity-100">
        <IconButton title="Download the page" aria-label="Download the page" onClick={() => download(file.name, html, "text/html")}>
          <Download size={13} />
        </IconButton>
        <IconButton title="Full screen" aria-label="Full screen" onClick={() => setFull(true)}>
          <Maximize2 size={13} />
        </IconButton>
      </div>
      {full && <FullScreen html={html} title={title} asked={asked} onAsk={setAsked} onClose={() => setFull(false)} />}
    </div>
  )
}

/** The page in its frame, as tall as it says it is. */
function PageFrame({
  html,
  title,
  initialHeight,
  onAsk,
  onEscape,
  className,
}: {
  html: string
  title: string
  initialHeight?: number | undefined
  onAsk: (url: string) => void
  /** Escape pressed in the page (that the page didn't take). */
  onEscape?: (() => void) | undefined
  className?: string | undefined
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => (initialHeight === undefined ? 120 : clampHeight(initialHeight)))
  // The theme as it is when the page loads: a change of tint shows the next time it does.
  const [doc] = useState(() => pageDocument(html, liveTheme()))
  const ask = useRef(onAsk)
  const escape = useRef(onEscape)
  useEffect(() => {
    ask.current = onAsk
    escape.current = onEscape
  })
  useEffect(() => {
    trackBoardInput()
    const onMessage = (e: MessageEvent) => {
      const el = frame.current
      if (el === null) return
      if (typeof e.data?.iaOpen === "string" && fromFrame(el, e.source)) {
        const url = e.data.iaOpen
        if (!openable(url)) return
        // As a document's links: at once after the user's own click in the page, else asked (see HtmlFrame in Document.tsx).
        if (followsFrameInput(el)) window.open(url, "_blank", "noopener,noreferrer")
        else if (navigator.userActivation?.isActive) ask.current(url)
        return
      }
      if (e.source !== el.contentWindow) return
      if (typeof e.data?.iaHtmlHeight === "number") setHeight(clampHeight(e.data.iaHtmlHeight))
      else if (e.data?.iaKey === "Escape") escape.current?.()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])
  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={doc}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className={clsx("block w-full border-0 bg-transparent", className)}
      style={{ height, colorScheme: "dark" }}
    />
  )
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/** The page over everything else, wider, with zoom. Escape closes it, in the page too. `asked`: a link the page asks to open. */
function FullScreen({
  html,
  title,
  asked,
  onAsk,
  onClose,
}: {
  html: string
  title: string
  asked: string | null
  onAsk: (url: string | null) => void
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const at = ZOOMS.indexOf(zoom)
  useEffect(() => {
    // Ahead of (and instead of) a dialog's or the task view's own Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-[60] flex flex-col items-center gap-2 bg-black/80 p-4 narrow:p-0"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex w-[min(1200px,94vw)] shrink-0 items-center gap-1 text-[12.5px] text-muted narrow:w-full narrow:px-2">
        <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
        <IconButton title="Zoom out" aria-label="Zoom out" disabled={at <= 0} onClick={() => setZoom(ZOOMS[at - 1] ?? zoom)}>
          <Minus size={13} />
        </IconButton>
        <button type="button" className="w-12 rounded px-1 text-center hover:text-fg" title="Actual size" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <IconButton title="Zoom in" aria-label="Zoom in" disabled={at >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[at + 1] ?? zoom)}>
          <Plus size={13} />
        </IconButton>
        <IconButton title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {asked && (
        <div className="w-[min(1200px,94vw)] shrink-0 overflow-hidden rounded-md bg-panel narrow:w-full">
          <OpenLinkBar what="page" url={asked} onDone={() => onAsk(null)} />
        </div>
      )}
      <div className="min-h-0 w-[min(1200px,94vw)] flex-1 overflow-auto rounded-lg border border-line bg-bg p-4 shadow-2xl narrow:w-full narrow:rounded-none">
        <div style={{ zoom }}>
          <PageFrame html={html} title={title} onAsk={onAsk} onEscape={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
