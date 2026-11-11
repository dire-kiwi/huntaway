declare global {
  interface Window {
    /** Trusted Types (Chromium's): not in TypeScript's DOM types yet. */
    readonly trustedTypes?: { createPolicy: (name: string, rules: Record<string, (s: string) => string>) => unknown } | undefined
  }
}

/**
 * What runs in a document's frame (see HtmlFrame in components/Document.tsx), after its HTML: it
 * leaves `inset` pixels at the bottom for what covers it (updated by an iaInset message), reports
 * where it's scrolled to (iaScroll), and after a reload puts it back at `y`. It runs as source, so
 * it can't use anything from outside.
 */
function keepPlace(y: number, inset: number) {
  const root = document.documentElement
  const pad = (b: number) => (root.style.paddingBottom = b ? `${b}px` : "")
  pad(inset)
  addEventListener("message", (e) => {
    if (e.source === parent && typeof e.data?.iaInset === "number") pad(e.data.iaInset)
  })
  // Put back on load, whenever that is (images and <ia-html> frames' scripts can hold it up). Layout can still
  // move after it (an <ia-html> frame reports its height), so it's put back again as the page changes size,
  // until the reader scrolls or 3s have passed.
  let hold = false
  const stop = () => (hold = false)
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(type, stop, { capture: true, passive: true })
  addEventListener("load", () => {
    if (!y) return
    scrollTo(0, y)
    hold = true
    setTimeout(stop, 3000)
    new ResizeObserver(() => hold && scrollTo(0, y)).observe(document.documentElement)
  })
  addEventListener("scroll", () => parent.postMessage({ iaScroll: scrollY }, "*"), { passive: true })
}

/**
 * Asks the board to open links to other pages (iaOpen, to the board's window): the frame has no allow-popups, and can't
 * load them itself (the board's frame-src, and FRAME_CSP for frames in it). `window.open` asks the same way. The board
 * opens one only after the user's own click or key press in the frame (see `followsFrameInput`), so it's not a way out
 * for the page either. Links within the page, and clicks the page handles itself, are left alone. It runs in a
 * document's frame and in an <ia-html>'s, as source.
 */
export function linksInNewTabs() {
  const board = top
  const ask = (url: string) => {
    try {
      board?.postMessage({ iaOpen: new URL(url, document.baseURI).href }, "*")
    } catch {
      /* not a URL */
    }
  }
  addEventListener("click", (e) => {
    if (e.defaultPrevented) return
    const a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null
    const href = a?.getAttribute("href")?.trim() ?? ""
    if (!a || !href || href.startsWith("#") || /^javascript:/i.test(href)) return
    e.preventDefault()
    ask(href)
  })
  window.open = (url?: string | URL) => {
    if (url) ask(String(url))
    return null
  }
}

/**
 * Takes WebRTC away from the page before its own scripts run: Chromium doesn't hold RTCPeerConnection to the frame's
 * policy, so a page could send data to a STUN or TURN server of its choosing, in its hostname or a TURN username
 * (HA-269). A frame in the page is of another origin (the sandbox gives each document an opaque origin of its own), so
 * the page can't take the constructor back from one, but a new document in it would have it: a srcdoc frame's scripts,
 * or a javascript: URL's (`<iframe src="javascript:…">`, which frame-src doesn't hold). For those, FRAME_CSP requires
 * Trusted Types, and this makes the default policy, which lets everything through: the page's innerHTML, eval and the
 * like work as before, but a new frame has no default policy, so it can't run a javascript: URL. A srcdoc frame of the
 * page's own still runs its scripts before anything can take WebRTC away there (in a browser: the desktop app takes it
 * away in every frame, see electron/preload.cjs). The board's <ia-html> frames run this first (planTheme.ts). Workers
 * have no RTCPeerConnection, but a classic one the page makes (from a blob: or data: URL, all worker-src allows) has the
 * policy without the default policy, which would fail its importScripts, eval and the like: it's started from a script
 * that makes one, then imports the page's. A blob: URL's Blob is kept as it's made, and imported from a URL of its own,
 * as pages often revoke theirs once the worker is made. (A worker that worker makes has no default policy.) It runs in
 * a document's frame, as source.
 */
export function noWebRtc() {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Reflect.deleteProperty(window, name)
  window.trustedTypes?.createPolicy("default", { createHTML: (s: string) => s, createScript: (s: string) => s, createScriptURL: (s: string) => s })
  const blobs = new Map<string, Blob>()
  const createObjectURL = URL.createObjectURL.bind(URL)
  const revokeObjectURL = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = createObjectURL(obj)
    if (obj instanceof Blob) blobs.set(url, obj)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    blobs.delete(url)
    revokeObjectURL(url)
  }
  const policy = 'self.trustedTypes?.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });'
  const PageWorker = Worker
  window.Worker = class extends PageWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const href = String(url)
      const blob = options?.type === "module" ? undefined : blobs.get(href)
      const own = blob ? createObjectURL(blob) : options?.type !== "module" && /^data:/i.test(href) ? href : null
      // (Its URL written into the script encoded, which needs no quoting.)
      const script = `${policy}\nimportScripts(decodeURIComponent("${own === null ? "" : encodeURIComponent(own)}"));`
      super(own ? createObjectURL(new Blob([script], { type: "text/javascript" })) : url, options)
    }
  }
}

/**
 * When the user last used the board itself, rather than a frame in it: a pointer down or up, the end of a touch or a key
 * press in its document. A touch or pen activates the page as it's lifted, not as it comes down (Chromium), so a held
 * touch's activation counts from its end (HA-274).
 */
let boardInput = -Infinity
let tracking = false
const note = (e: Event) => e.isTrusted && (boardInput = performance.now())
/** Starts keeping `boardInput` (once). */
export function trackBoardInput() {
  if (tracking) return
  tracking = true
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"]) addEventListener(type, note, true)
}

/**
 * How long a user activation lasts in Chromium (5s), and more: after a touch held on the board, Chromium 155 kept the
 * board's activation over 6s from the touch's end (6.2, documentCsp.test.mjs; the old 5.5s let the frame's ask open).
 */
const ACTIVATION_MS = 8000

/**
 * Whether the board has the user's activation from their own click or key press in `frame` (or a frame in it). Their
 * input activates the frames above the one it's in, the board's included, and focus is in that frame. But the board's
 * own input activates it too, and a frame can take the focus after it (Chromium lets it), so it's only the frame's when
 * the board has had none for as long as an activation lasts. When it isn't, the board asks before it opens a link (as
 * Electron, the desktop app, has no popup blocker, a page could otherwise send its contents out in a link of its own).
 */
export const followsFrameInput = (frame: HTMLIFrameElement | null) =>
  !!frame && navigator.userActivation?.isActive && document.activeElement === frame && performance.now() - boardInput > ACTIVATION_MS

/** Whether `url` is one a document may open: a web or mail link. */
export const openable = (url: string) => /^(https?|mailto):/i.test(url)

/** Whether `source` (a message's) is `frame`'s window or one in it, up to a few levels down (an <ia-html>'s). */
export function fromFrame(frame: HTMLIFrameElement | null, source: MessageEventSource | null) {
  let w = source === null || !isWindow(source) ? null : source
  for (let i = 0; w && i < 4; i++, w = w.parent === w ? null : w.parent) if (w === frame?.contentWindow) return true
  return false
}

/** A message's source that is a window (of another origin, so not one of this page's `Window`s). */
const isWindow = (s: MessageEventSource): s is Window => !(s instanceof MessagePort) && !(typeof ServiceWorker !== "undefined" && s instanceof ServiceWorker)

/** Where a document's page may load scripts, styles and fonts from: the CDNs the plan and artifact prompts name (agent/documents.ts in the server). */
const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com"

/**
 * What a document's frame may load: its own inline scripts and styles, libraries from the CDNs, Google Fonts, and data:
 * and blob: URLs. So a page an agent wrote (say, prompted by a poisoned issue) can't send what's in it, or the answers
 * typed into it, out with remote images, fetch, frames or form posts. The frame's own navigations are held by the
 * board's frame-src (index.html), and its links by `linksInNewTabs`. An <ia-html>'s frame (srcdoc) inherits it.
 * WebRTC isn't held to CSP, so `noWebRtc` takes it away, and Trusted Types (with its default policy) keep a javascript:
 * URL frame from getting it back. What's left is in browsers, not the desktop app (HA-269): a srcdoc frame the page
 * makes itself can use WebRTC (it has no default policy, so its own innerHTML and the like with strings fail), and
 * unless Chrome's "Preload pages" setting is off, it still looks up and connects to (TLS SNI included) the host of a
 * frame load the policy refuses (an <iframe>, or a frame navigating itself) and of a <link rel=preconnect>, in the
 * page's HTML or added by its script. Each sends data out in a hostname of the page's choosing. Nothing the board sets
 * changes the last two: the frame served with the policy as a header, the iframe's `csp` attribute, COOP and COEP were
 * tried, and `x-dns-prefetch-control: off` doesn't hold preconnect (dns-prefetch links and links' hosts aren't looked
 * up in the frame, even with it on).
 */
export const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${CDNS}`,
  `style-src 'unsafe-inline' data: ${CDNS} https://fonts.googleapis.com`,
  `font-src data: ${CDNS} https://fonts.gstatic.com`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src data: blob:",
  "worker-src data: blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join("; ")

/**
 * A document's HTML with its policy (FRAME_CSP) before anything in it, and the script that keeps its place (`keepPlace`)
 * (with `linksInNewTabs`) after. The policy comes first of all, then `noWebRtc`, with a doctype of its own (the page's, after it, is ignored), rather than after
 * the page's doctype or comments: finding where those end as the browser does isn't worth the risk of a script before it.
 */
export const frameDoc = (html: string, y: number, inset: number) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>(${String(noWebRtc)})()</script>\n${html}\n<script>(${String(keepPlace)})(${y},${inset});(${String(linksInNewTabs)})()</script>`
