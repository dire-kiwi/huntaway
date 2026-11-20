import { Effect, Option, Schema } from "effect"
import { isRecord, jsonText, nextEvent, num, str } from "./cdp.ts"
import type { CdpError, CdpEvent, CdpPage, CdpResult } from "./cdp.ts"
import { parseKeys } from "./keys.ts"
import { formatSnapshot, parseRef } from "./snapshot.ts"

// What the agent does with a page (HE-62), over CDP alone, so a headless Chrome's page and the desktop app's <webview>
// are driven the same way: load an address, read the page as an outline with refs, click, type, press keys, scroll,
// run a script, take a picture. An action that starts a navigation waits for the new page to load (at most
// `LOAD_TIMEOUT`); one that doesn't returns at once.

/** The agent's action can't be done as asked: what to tell it. */
export class PageRefused extends Schema.TaggedError<PageRefused, { readonly brand: unique symbol }>()("PageRefused", {
  reason: Schema.String,
}) {}

export const LOAD_TIMEOUT = "15 seconds"
/** How long an action waits to see whether it started a navigation. */
const NAVIGATION_START = "400 millis"

export interface PageInfo {
  readonly url: string
  readonly title: string
}

const isLoad = (e: CdpEvent) => e.method === "Page.loadEventFired"
/** A navigation is over: its page loaded, or it came back from the back/forward cache, which fires no load. */
const isSettled = (e: CdpEvent) => isLoad(e) || e.method === "Page.frameStoppedLoading" || e.method === "Page.navigatedWithinDocument"
const isMainStart = (e: CdpEvent) =>
  e.method === "Page.frameStartedLoading" || (e.method === "Page.frameRequestedNavigation" && str(e.params, "disposition") === "currentTab")

/** The main frame's new document has committed. */
const isMainCommit = (e: CdpEvent) => e.method === "Page.frameNavigated" && isRecord(e.params["frame"]) && e.params["frame"]["parentId"] === undefined

/** Stop the page's loading (best effort). */
const stop = (page: CdpPage) => page.send("Page.stopLoading", {}, "5 seconds").pipe(Effect.ignore)

/** What a page needs on before it's driven (each call is safe to repeat). */
export const preparePage = (page: CdpPage) =>
  Effect.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("DOM.enable"), page.send("Accessibility.enable")], {
    concurrency: 1,
    discard: true,
  })

/** The page's address and title. */
export const pageInfo = (page: CdpPage): Effect.Effect<PageInfo, CdpError> =>
  Effect.map(page.send("Runtime.evaluate", { expression: "[location.href, document.title]", returnByValue: true }), (r) => {
    const v = isRecord(r["result"]) ? r["result"]["value"] : undefined
    return Array.isArray(v) ? { url: String(v[0] ?? ""), title: String(v[1] ?? "") } : { url: "", title: "" }
  })

/** Run `action`; if it starts a navigation of the page, wait for that page to load. */
const settling = <A, E>(page: CdpPage, action: Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sub = yield* page.subscribe
      const out = yield* action
      const started = yield* nextEvent(page, sub, (e) => isMainStart(e) || isLoad(e), NAVIGATION_START)
      if (Option.isNone(started) || isLoad(started.value)) return out
      // Until a navigation commits, Chrome holds every later command of the page's: one to a host that never answers
      // is stopped, so the page doesn't stay stuck.
      const next = yield* nextEvent(page, sub, (e) => isSettled(e) || isMainCommit(e), LOAD_TIMEOUT)
      if (Option.isNone(next)) yield* stop(page)
      else if (!isSettled(next.value)) yield* nextEvent(page, sub, isSettled, LOAD_TIMEOUT)
      return out
    }),
  )

/** Load `url` in the page; fails with the browser's reason when it can't (no such host, refused…). */
export const navigate = (page: CdpPage, url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sub = yield* page.subscribe
      // Chrome answers once the navigation commits, and holds the page's other commands until then: one that doesn't
      // in time (a host that never answers) is stopped, so the page doesn't stay stuck.
      const r = yield* page
        .send("Page.navigate", { url }, LOAD_TIMEOUT)
        .pipe(
          Effect.catchTag("CdpError", (e) =>
            Effect.andThen(stop(page), Effect.fail(new PageRefused({ reason: `${url} didn't load: ${e.reason}, so it was stopped.` }))),
          ),
        )
      const failed = str(r, "errorText")
      if (failed !== "") return yield* new PageRefused({ reason: `${url} didn't load: ${failed}` })
      // A same-document navigation (only the #fragment changed) has no loader and fires no load event.
      if (str(r, "loaderId") !== "") yield* nextEvent(page, sub, isLoad, LOAD_TIMEOUT)
      return yield* Effect.void
    }),
  )

/** Back, forward or reload. */
export const history = (page: CdpPage, go: "back" | "forward" | "reload") =>
  Effect.gen(function* () {
    if (go === "reload") return yield* Effect.asVoid(settling(page, page.send("Page.reload")))
    const h = yield* page.send("Page.getNavigationHistory")
    const entries = Array.isArray(h["entries"]) ? h["entries"] : []
    const at = num(h, "currentIndex") + (go === "back" ? -1 : 1)
    const entry: unknown = entries[at]
    if (!isRecord(entry)) return yield* new PageRefused({ reason: `There's no page to go ${go} to.` })
    return yield* Effect.asVoid(settling(page, page.send("Page.navigateToHistoryEntry", { entryId: num(entry, "id") })))
  })

/** The page as an outline with refs. */
export const snapshot = (page: CdpPage) =>
  Effect.map(page.send("Accessibility.getFullAXTree", {}), (r) => formatSnapshot(Array.isArray(r["nodes"]) ? r["nodes"] : []))

/** The node a ref names, or why not. */
const nodeOf = (ref: string) => {
  const id = parseRef(ref)
  return id === null ? Effect.fail(new PageRefused({ reason: `${ref} isn't a ref: give one from the latest snapshot, like e12.` })) : Effect.succeed(id)
}

/** A ref that no longer names anything on the page. */
const stale = (ref: string) => (e: CdpError) => new PageRefused({ reason: `${ref} isn't on the page any more (${e.reason}): take a new snapshot.` })

/** The middle of what `ref` names, scrolled into view, in the page's CSS pixels. */
const centreOf = (page: CdpPage, ref: string) =>
  Effect.gen(function* () {
    const backendNodeId = yield* nodeOf(ref)
    yield* page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).pipe(Effect.mapError(stale(ref)))
    const q = yield* page.send("DOM.getContentQuads", { backendNodeId }).pipe(Effect.mapError(stale(ref)))
    const quad: unknown = Array.isArray(q["quads"]) ? q["quads"][0] : undefined
    if (!Array.isArray(quad) || quad.length < 8) return yield* new PageRefused({ reason: `${ref} has no size on the page (hidden?), so it can't be clicked.` })
    const xs = [0, 2, 4, 6].map((i) => Number(quad[i]))
    const ys = [1, 3, 5, 7].map((i) => Number(quad[i]))
    return { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 }
  })

/** A click at `at` (CSS pixels) with the left button, `count` times quickly (2 for a double click). */
export const clickAt = (page: CdpPage, at: { readonly x: number; readonly y: number }, count = 1, modifiers = 0) =>
  settling(
    page,
    Effect.gen(function* () {
      yield* page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, modifiers })
      for (let n = 1; n <= count; n++) {
        yield* page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: n, modifiers })
        yield* page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: n, modifiers })
      }
    }),
  )

/** Click what `ref` names. */
export const click = (page: CdpPage, ref: string, count = 1) => Effect.flatMap(centreOf(page, ref), (at) => clickAt(page, at, count))

/** Move the mouse over what `ref` names. */
export const hover = (page: CdpPage, ref: string) =>
  Effect.flatMap(centreOf(page, ref), (at) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }))

const CLEAR = `function () {
  if (this.isContentEditable) this.textContent = "";
  else if ("value" in this) { this.value = ""; }
  this.dispatchEvent(new Event("input", { bubbles: true }));
}`

/** Press `spec` ("Enter", "Control+a"). */
export const press = (page: CdpPage, spec: string) =>
  Effect.gen(function* () {
    const k = parseKeys(spec)
    if (k === null) return yield* new PageRefused({ reason: `${spec} isn't a key: use names like Enter, Tab, Escape, ArrowDown, a, Control+a, Shift+Tab.` })
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers }
    return yield* settling(
      page,
      Effect.andThen(
        page.send(
          "Input.dispatchKeyEvent",
          k.text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text },
        ),
        page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }),
      ),
    )
  })

/** Type `text` into what `ref` names (focused first, emptied when `clear`), or wherever the focus is; Enter after when `submit`. */
export const type = (page: CdpPage, ref: string | undefined, text: string, clear: boolean, submit: boolean) =>
  Effect.gen(function* () {
    if (ref !== undefined) {
      const backendNodeId = yield* nodeOf(ref)
      yield* page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).pipe(Effect.mapError(stale(ref)))
      yield* page.send("DOM.focus", { backendNodeId }).pipe(Effect.mapError(stale(ref)))
      if (clear) {
        const r = yield* page.send("DOM.resolveNode", { backendNodeId }).pipe(Effect.mapError(stale(ref)))
        const objectId = isRecord(r["object"]) ? str(r["object"], "objectId") : ""
        if (objectId !== "") yield* page.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CLEAR })
      }
    }
    if (text !== "") yield* page.send("Input.insertText", { text })
    if (submit) yield* press(page, "Enter")
  })

/** Scroll what `ref` names into view, or the page by `dx`, `dy` CSS pixels. */
export const scroll = (page: CdpPage, ref: string | undefined, dx: number, dy: number): Effect.Effect<void, CdpError | PageRefused> =>
  ref !== undefined
    ? Effect.flatMap(nodeOf(ref), (backendNodeId) =>
        page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).pipe(Effect.mapError(stale(ref)), Effect.asVoid),
      )
    : Effect.gen(function* () {
        const m = yield* page.send("Page.getLayoutMetrics")
        const v = isRecord(m["cssVisualViewport"]) ? m["cssVisualViewport"] : undefined
        const x = num(v, "clientWidth", 800) / 2
        const y = num(v, "clientHeight", 600) / 2
        yield* page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy })
        // The page scrolls on its next frames: the action is done once they're drawn (a hidden page draws none).
        yield* page.send("Runtime.evaluate", { expression: AFTER_FRAMES, awaitPromise: true }, "1 second").pipe(Effect.ignore)
      })

const AFTER_FRAMES = "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))"

/** The most of an evaluation's result given back. */
const EVALUATE_MAX = 30_000

/** Run `expression` in the page (awaiting a promise it gives) and say what it came to, or what it threw. */
export const evaluate = (page: CdpPage, expression: string) =>
  Effect.gen(function* () {
    const r: CdpResult = yield* page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, LOAD_TIMEOUT)
    const thrown = r["exceptionDetails"]
    if (isRecord(thrown)) {
      const ex = isRecord(thrown["exception"]) ? thrown["exception"] : undefined
      return { ok: false, text: str(ex, "description") || str(thrown, "text") || "it threw" }
    }
    const result = isRecord(r["result"]) ? r["result"] : {}
    const value = "value" in result ? result["value"] : result["description"]
    const shown = value === undefined ? "undefined" : typeof value === "string" ? value : jsonText(value, true)
    return { ok: true, text: shown.length > EVALUATE_MAX ? `${shown.slice(0, EVALUATE_MAX)}\n[… ${shown.length - EVALUATE_MAX} more characters]` : shown }
  })

/** A PNG of what the page shows now, base64. */
export const screenshot = (page: CdpPage) => Effect.map(page.send("Page.captureScreenshot", { format: "png" }, "20 seconds"), (r) => str(r, "data"))
