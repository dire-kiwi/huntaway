// The content security policy of the board's document frames (apps/web/src/components/task/htmlFrame.ts): plans,
// artifacts, <ia-html> frames and agents' HTML pages in a thread (HE-78). Here so that the server's html_preview loads a
// page under the same policy the board shows it with, and the agent sees what the reader will.

/** Where a document's page may load scripts, styles and fonts from: the CDNs the plan and artifact prompts name (agent/documents.ts in the server). */
export const FRAME_CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com"

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
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${FRAME_CDNS}`,
  `style-src 'unsafe-inline' data: ${FRAME_CDNS} https://fonts.googleapis.com`,
  `font-src data: ${FRAME_CDNS} https://fonts.gstatic.com`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src data: blob:",
  "worker-src data: blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join("; ")
