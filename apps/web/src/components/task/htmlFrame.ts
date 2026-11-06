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
 * Opens links to other pages in a new tab: the frame can't load them (the board's frame-src, and FRAME_CSP for frames in
 * it). Links within the page, and those it handles itself, are left alone. It runs in a document's frame, as source.
 */
export function linksInNewTabs() {
  addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null;
      const href = a?.getAttribute("href")?.trim() ?? "";
      if (!a || !href || href.startsWith("#") || /^javascript:/i.test(href)) return;
      const target = (a.getAttribute("target") ?? "").toLowerCase();
      if (!target || target === "_self" || target === "_parent" || target === "_top") a.setAttribute("target", "_blank");
    },
    { capture: true },
  );
}

/** Where a document's page may load scripts, styles and fonts from: the CDNs the plan and artifact prompts name (agent/documents.ts in the server). */
const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

/**
 * What a document's frame may load: its own inline scripts and styles, libraries from the CDNs, Google Fonts, and data:
 * and blob: URLs. Nothing else goes out, so a page an agent wrote (say, prompted by a poisoned issue) can't send what's
 * in it, or the answers typed into it, anywhere: no remote images, fetch, frames or form posts. The frame's own
 * navigations are held by the board's frame-src (index.html). An <ia-html>'s frame (srcdoc) inherits it.
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
