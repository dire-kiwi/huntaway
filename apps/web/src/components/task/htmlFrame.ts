/**
 * What runs in a document's frame (see HtmlFrame in components/Document.tsx), after its HTML: it
 * leaves `inset` pixels at the bottom for what covers it (updated by an iaInset message), reports
 * where it's scrolled to (iaScroll), and after a reload puts it back at `y`. It runs as source, so
 * it can't use anything from outside.
 */
function keepPlace(y: number, inset: number) {
  const pad = (b: number) => (document.documentElement.style.paddingBottom = b ? `${b}px` : "");
  pad(inset);
  addEventListener("message", (e) => {
    if (e.source === parent && typeof e.data?.iaInset === "number") pad(e.data.iaInset);
  });
  // Put back on load, whenever that is (images and <ia-html> frames' scripts can hold it up). Layout can still
  // move after it (an <ia-html> frame reports its height), so it's put back again as the page changes size,
  // until the reader scrolls or 3s have passed.
  let hold = false;
  const stop = () => (hold = false);
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(type, stop, { capture: true, passive: true });
  addEventListener("load", () => {
    if (!y) return;
    scrollTo(0, y);
    hold = true;
    setTimeout(stop, 3000);
    new ResizeObserver(() => hold && scrollTo(0, y)).observe(document.documentElement);
  });
  addEventListener("scroll", () => parent.postMessage({ iaScroll: scrollY }, "*"), { passive: true });
}

/**
 * Asks the board to open links to other pages (iaOpen, to the board's window): the frame has no allow-popups, and can't
 * load them itself (the board's frame-src, and FRAME_CSP for frames in it). `window.open` asks the same way. The board
 * opens one only after the user's own click or key press in the frame (see `followsFrameInput`), so it's not a way out
 * for the page either. Links within the page, and clicks the page handles itself, are left alone. It runs in a
 * document's frame and in an <ia-html>'s, as source.
 */
export function linksInNewTabs() {
  const ask = (url: string) => {
    try {
      top!.postMessage({ iaOpen: new URL(url, document.baseURI).href }, "*");
    } catch {
      /* not a URL */
    }
  };
  addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    const a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null;
    const href = a?.getAttribute("href")?.trim() ?? "";
    if (!a || !href || href.startsWith("#") || /^javascript:/i.test(href)) return;
    e.preventDefault();
    ask(href);
  });
  window.open = (url?: string | URL) => {
    if (url) ask(String(url));
    return null;
  };
}

/** When the user last used the board itself, rather than a frame in it: a pointer down or key press in its document. */
let boardInput = -Infinity;
let tracking = false;
/** Starts keeping `boardInput` (once). */
export function trackBoardInput() {
  if (tracking) return;
  tracking = true;
  const note = (e: Event) => e.isTrusted && (boardInput = performance.now());
  addEventListener("pointerdown", note, true);
  addEventListener("keydown", note, true);
}

/** How long a user activation lasts in Chromium (5s), and a little more. */
const ACTIVATION_MS = 5500;

/**
 * Whether the board has the user's activation from their own click or key press in `frame` (or a frame in it). Their
 * input activates the frames above the one it's in, the board's included, and focus is in that frame. But the board's
 * own input activates it too, and a frame can take the focus after it (Chromium lets it), so it's only the frame's when
 * the board has had none for as long as an activation lasts. When it isn't, the board asks before it opens a link (as
 * Electron, the desktop app, has no popup blocker, a page could otherwise send its contents out in a link of its own).
 */
export const followsFrameInput = (frame: HTMLIFrameElement | null) =>
  !!frame && navigator.userActivation?.isActive === true && document.activeElement === frame && performance.now() - boardInput > ACTIVATION_MS;

/** Whether `url` is one a document may open: a web or mail link. */
export const openable = (url: string) => /^(https?|mailto):/i.test(url);

/** Whether `source` (a message's) is `frame`'s window or one in it, up to a few levels down (an <ia-html>'s). */
export function fromFrame(frame: HTMLIFrameElement | null, source: MessageEventSource | null) {
  let w = source as Window | null;
  for (let i = 0; w && i < 4; i++, w = w.parent === w ? null : w.parent) if (w === frame?.contentWindow) return true;
  return false;
}

/** Where a document's page may load scripts, styles and fonts from: the CDNs the plan and artifact prompts name (agent/documents.ts in the server). */
const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

/**
 * What a document's frame may load: its own inline scripts and styles, libraries from the CDNs, Google Fonts, and data:
 * and blob: URLs. So a page an agent wrote (say, prompted by a poisoned issue) can't send what's in it, or the answers
 * typed into it, out with remote images, fetch, frames or form posts. The frame's own navigations are held by the
 * board's frame-src (index.html), and its links by `linksInNewTabs`. An <ia-html>'s frame (srcdoc) inherits it.
 * Two ways out remain, both through a hostname of the page's choosing (HA-269): WebRTC, which Chromium doesn't hold to
 * CSP (a STUN or TURN server), and, in browsers but not Electron, a frame load the policy refuses (an <iframe>, or a
 * frame navigating itself), for which Chromium still looks the host up and connects to it, TLS SNI included.
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
].join("; ");

/**
 * A document's HTML with its policy (FRAME_CSP) before anything in it, and the script that keeps its place (`keepPlace`)
 * (with `linksInNewTabs`) after. The policy comes first of all, with a doctype of its own (the page's, after it, is ignored), rather than after
 * the page's doctype or comments: finding where those end as the browser does isn't worth the risk of a script before it.
 */
export const frameDoc = (html: string, y: number, inset: number) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">\n${html}\n<script>(${keepPlace})(${y},${inset});(${linksInNewTabs})()</script>`;
