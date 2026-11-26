import { FRAME_CSP } from "@huntaway/shared"
import { toJson } from "./json"

// A plugin's page in its frame, on the phone (HE-99; docs/plan/15-plugins.md, Pages): the plugin's HTML with the policy
// the web board's frames load under (FRAME_CSP: no network), the board's theme on its `:root`, and `window.huntaway`,
// the bridge to the app (`call`, `navigate`, `openTask`, `onEvent`, `context`). It is the web's
// components/plugins/frameSource.ts and task/htmlFrame.ts over again, for a web view: the scripts are text here, not
// functions turned to text, since Hermes keeps bytecode and no source; and the page talks to the app through the web
// view's `ReactNativeWebView.postMessage` (text), or to the page around it when the app runs in a browser for a check.

/** What a frame's page is told of where it is. */
export interface FrameContext {
  readonly host: string
  readonly plugin: string
  readonly slot: "page" | "settings" | "task"
  readonly path: string
  readonly task_id: string | null
}

/**
 * Before anything of the page's: WebRTC taken away (it isn't held to the policy), and Trusted Types' default policy,
 * which the policy requires and a new frame of the page's hasn't (htmlFrame.ts' `noWebRtc`, which says why, workers
 * included).
 */
const GUARD = String.raw`function () {
  ["RTCPeerConnection", "webkitRTCPeerConnection"].forEach(function (name) { try { delete window[name] } catch (e) {} });
  if (window.trustedTypes) window.trustedTypes.createPolicy("default", { createHTML: function (s) { return s }, createScript: function (s) { return s }, createScriptURL: function (s) { return s } });
  var blobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) { var url = createObjectURL(obj); if (obj instanceof Blob) blobs.set(url, obj); return url };
  URL.revokeObjectURL = function (url) { blobs.delete(url); revokeObjectURL(url) };
  var policy = 'self.trustedTypes&&self.trustedTypes.createPolicy("default",{createHTML:function(s){return s},createScript:function(s){return s},createScriptURL:function(s){return s}});';
  var PageWorker = window.Worker;
  if (PageWorker) window.Worker = class extends PageWorker {
    constructor(url, options) {
      var href = String(url);
      var classic = !options || options.type !== "module";
      var blob = classic ? blobs.get(href) : undefined;
      var own = blob ? createObjectURL(blob) : classic && /^data:/i.test(href) ? href : null;
      var script = policy + '\nimportScripts(decodeURIComponent("' + (own === null ? "" : encodeURIComponent(own)) + '"));';
      super(own ? createObjectURL(new Blob([script], { type: "text/javascript" })) : url, options);
    }
  };
}`

/**
 * The bridge. To the app: `{iaPlugin: {kind, …}}` for `call` (answered with `{iaPluginReply: {id, ok, value | error}}`),
 * `navigate`, `openTask` and `height` (when the app sizes the frame to its page), and `{iaOpen: url}` for a link the
 * user followed, resolved against the page's address on the board (`base`). From the app, through `__huntawayDeliver`
 * (a web view) or a message (a browser): the replies, and the plugin's events as `{iaPluginEvent: event}`.
 * `__huntawayLinks` starts following links, once the page's own scripts have had the first say (it is called after
 * them). A page that fills its frame says where it is scrolled to (`scroll`, a few times a second at most), and one
 * loaded again (the plugin's event said `reload`: an answer saved, a comment added) is put back at `y`, and again as its
 * layout settles, until the reader touches it (htmlFrame.ts' `keepPlace`).
 */
const BRIDGE = String.raw`function (context, base, report, y) {
  var native = function () { return window.ReactNativeWebView };
  var send = function (m) {
    var n = native();
    if (n) n.postMessage(JSON.stringify(m));
    else if (parent !== window) parent.postMessage(m, "*");
  };
  var post = function (m) { send({ iaPlugin: m }) };
  var waiting = new Map();
  var listeners = [];
  var next = 0;
  window.huntaway = {
    context: context,
    call: function (method, payload) {
      return new Promise(function (resolve, reject) {
        next += 1;
        waiting.set(next, { resolve: resolve, reject: reject });
        post({ kind: "call", id: next, method: method, payload: payload === undefined ? null : payload });
      });
    },
    navigate: function (path) { post({ kind: "navigate", path: path }) },
    openTask: function (id) { post({ kind: "openTask", id: id }) },
    onEvent: function (listener) { listeners.push(listener) }
  };
  var deliver = function (data) {
    if (!data || typeof data !== "object") return;
    var reply = data.iaPluginReply;
    if (reply && typeof reply.id === "number") {
      var w = waiting.get(reply.id);
      waiting.delete(reply.id);
      if (w) { if (reply.ok) w.resolve(reply.value); else w.reject(new Error(String(reply.error))) }
    }
    if (data.iaPluginEvent) listeners.forEach(function (listener) { listener(data.iaPluginEvent) });
  };
  window.__huntawayDeliver = deliver;
  addEventListener("message", function (e) { if (!native() && e.source === parent) deliver(e.data) });
  var ask = function (url) { try { send({ iaOpen: new URL(url, base).href }) } catch (e) {} };
  window.__huntawayLinks = function () {
    delete window.__huntawayLinks;
    addEventListener("click", function (e) {
      if (e.defaultPrevented) return;
      var a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null;
      var href = a ? (a.getAttribute("href") || "").trim() : "";
      if (!a || !href || href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
      e.preventDefault();
      ask(href);
    });
    window.open = function (url) { if (url) ask(String(url)); return null };
  };
  if (report) {
    var tell = function () { post({ kind: "height", height: Math.ceil(document.documentElement.getBoundingClientRect().height) }) };
    addEventListener("load", tell);
    new ResizeObserver(tell).observe(document.documentElement);
  } else {
    var hold = false;
    var release = function () { hold = false };
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach(function (type) { addEventListener(type, release, { capture: true, passive: true }) });
    addEventListener("load", function () {
      if (!y) return;
      scrollTo(0, y);
      hold = true;
      var until = Date.now() + 3000;
      new ResizeObserver(function () { if (hold && Date.now() < until) scrollTo(0, y) }).observe(document.documentElement);
    });
    var pending = 0;
    addEventListener("scroll", function () {
      if (pending) return;
      pending = setTimeout(function () { pending = 0; post({ kind: "scroll", y: Math.round(scrollY) }) }, 200);
    }, { passive: true });
  }
}`

/** A value as a script's argument: inside a <script>, so nothing in it closes it. */
const arg = (v: unknown): string => toJson(v).replace(/</g, "\\u003c")

/**
 * The frame's page for a plugin's `html`: the policy before anything of the page's, the guard and the bridge before its
 * scripts, the theme (`vars`: a `:root`'s declarations), and its links followed after its scripts. `base` is the
 * page's address on the board, which its links resolve against; with `report` the page says how tall it is, and the
 * app sizes its frame to it; `y` is where a page loaded again was scrolled to.
 */
export function frameDocument(
  html: string,
  options: { readonly vars: string; readonly context: FrameContext; readonly base: string; readonly report: boolean; readonly y?: number },
): string {
  const { vars, context, base, report, y = 0 } = options
  return (
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<script>(${GUARD})();(${BRIDGE})(${arg(context)},${arg(base)},${report},${Math.max(0, Math.round(y))})</script>` +
    `<style>:root{${vars}}html,body{margin:0}html{-webkit-text-size-adjust:100%;${report ? "overflow:hidden" : "background:var(--color-bg)"}}</style>\n` +
    `${html}\n<script>window.__huntawayLinks&&window.__huntawayLinks()</script>`
  )
}

/** What a frame's page asks of the app. */
export type FrameMessage =
  | { readonly kind: "call"; readonly id: number; readonly method: string; readonly payload: unknown }
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "openTask"; readonly id: string }
  | { readonly kind: "height"; readonly height: number }
  /** Where a page that fills its frame is scrolled to. */
  | { readonly kind: "scroll"; readonly y: number }
  /** A link the user followed, as the page resolved it. */
  | { readonly kind: "open"; readonly url: string }

const field = (o: object, key: string): unknown => Reflect.get(o, key)

/** What a frame's page posted, if it is one of the bridge's messages (pure). Anything else is the page's own business. */
export function frameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null
  const open = field(data, "iaOpen")
  if (typeof open === "string") return { kind: "open", url: open }
  const m = field(data, "iaPlugin")
  if (typeof m !== "object" || m === null) return null
  const kind = field(m, "kind")
  const id = field(m, "id")
  if (kind === "call") {
    const method = field(m, "method")
    return typeof id === "number" && typeof method === "string" ? { kind, id, method, payload: field(m, "payload") } : null
  }
  if (kind === "navigate") {
    const path = field(m, "path")
    // A board path, never another site's.
    return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? { kind, path } : null
  }
  if (kind === "openTask") return typeof id === "string" ? { kind, id } : null
  if (kind === "height") {
    const height = field(m, "height")
    return typeof height === "number" && Number.isFinite(height) ? { kind, height: Math.min(Math.max(height, 0), 4000) } : null
  }
  if (kind === "scroll") {
    const y = field(m, "y")
    return typeof y === "number" && Number.isFinite(y) ? { kind, y: Math.max(y, 0) } : null
  }
  return null
}

/** What goes back into a frame's page: a call's answer, or one of the plugin's events. */
export type FrameReply =
  | {
      readonly iaPluginReply:
        | { readonly id: number; readonly ok: true; readonly value: unknown }
        | { readonly id: number; readonly ok: false; readonly error: string }
    }
  | { readonly iaPluginEvent: unknown }

/** The script that hands `reply` to a web view's page (`injectJavaScript`). */
export const deliverScript = (reply: FrameReply): string => `window.__huntawayDeliver&&window.__huntawayDeliver(${arg(reply)});true;`
