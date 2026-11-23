import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { transformWithOxc } from "vite"
import { FRAME_CSP } from "@huntaway/shared"
import { deliverScript, frameDocument, frameMessage } from "../src/logic/frame"
import { frameBase, frameLink, FRAME_ORIGIN, messageLink, pageHref, pagePath, publishedDoc, targetOfPath } from "../src/logic/links"

// HE-99: a plugin's page on the phone (the documents): where its links lead, the page its frame loads, and what the
// frame may ask of the app.

const doc = { plugin: "docs", path: "p1/d/plan/", search: "" }

/** What a document's page posts for a link of its own: the link resolved against the page's address in its frame. */
const resolved = (href: string) => new URL(href, frameBase(doc)).href

describe("where a link leads", () => {
  it("opens a plugin's page and a task in the app, and the board's other pages on the web", () => {
    expect(targetOfPath("/docs/p1/d/plan/")).toEqual({ kind: "page", ...doc })
    expect(targetOfPath("/docs/p1/d/plan/-/v/2/intro", "details=1")).toEqual({
      kind: "page",
      plugin: "docs",
      path: "p1/d/plan/-/v/2/intro",
      search: "details=1",
    })
    expect(targetOfPath("/notes")).toEqual({ kind: "page", plugin: "notes", path: "", search: "" })
    expect(targetOfPath("/t/abc")).toEqual({ kind: "task", id: "abc" })
    expect(targetOfPath("/settings/network")).toEqual({ kind: "web", path: "/settings/network" })
    expect(targetOfPath("/p/x/settings", "tab=git")).toEqual({ kind: "web", path: "/p/x/settings?tab=git" })
    expect(targetOfPath("/")).toEqual({ kind: "web", path: "/" })
  })

  it("keeps a page's path as its link had it, and gives the plugin its segments", () => {
    expect(pagePath("p1/d/my%20plan/")).toBe("p1/d/my plan")
    expect(pageHref({ plugin: "docs", path: "p1/d/plan/", search: "details=1" })).toBe("/docs/p1/d/plan/?details=1")
    expect(frameBase(doc)).toBe(`${FRAME_ORIGIN}/docs/p1/d/plan/`)
  })

  it("takes a frame's link as the board's own when it stays on the page's address, and as another site's otherwise", () => {
    expect(frameLink(resolved("/docs/p1"))).toEqual({ kind: "page", plugin: "docs", path: "p1", search: "" })
    expect(frameLink(resolved("intro"))).toEqual({ kind: "page", plugin: "docs", path: "p1/d/plan/intro", search: "" })
    expect(frameLink(resolved("-/edit/?x=1"))).toEqual({ kind: "page", plugin: "docs", path: "p1/d/plan/-/edit/", search: "x=1" })
    expect(frameLink(resolved("https://example.com/a?b=c"))).toEqual({ kind: "external", url: "https://example.com/a?b=c" })
    expect(frameLink(resolved("mailto:a@example.com"))).toEqual({ kind: "external", url: "mailto:a@example.com" })
    expect(frameLink("file:///etc/passwd")).toBeNull()
    expect(frameLink("intent://x")).toBeNull()
    expect(frameLink("not a url")).toBeNull()
  })

  it("opens a message's link to one of the board's documents in the app, whatever address the agent knew the board by", () => {
    const board = "http://192.168.1.5:7879"
    expect(messageLink("http://127.0.0.1:7879/docs/p1/d/plan/", board)).toEqual({ kind: "page", ...doc })
    expect(messageLink("http://192.168.1.5:7879/docs/p1/d/plan/?details=1", board)).toEqual({ kind: "page", ...doc, search: "details=1" })
    expect(messageLink("/docs/p1/d/plan/", board)).toEqual({ kind: "page", ...doc })
    expect(messageLink("http://192.168.1.5:7879/t/abc", board)).toEqual({ kind: "task", id: "abc" })
    // A dev server on the host's own address is no page of the board's.
    expect(messageLink("http://localhost:5173/docs/intro", board)).toEqual({ kind: "external", url: "http://localhost:5173/docs/intro" })
    expect(messageLink("https://docs.example.com/docs/p1/d/plan/", board)).toEqual({ kind: "external", url: "https://docs.example.com/docs/p1/d/plan/" })
    expect(messageLink("javascript:alert(1)", board)).toBeNull()
  })

  it("finds the document a publish_document call's result names", () => {
    expect(publishedDoc('{"slug":"plan","version":3,"url":"http://127.0.0.1:7879/docs/p1/d/plan/"}')).toEqual({ page: doc, slug: "plan", version: 3 })
    expect(
      publishedDoc('{"url":"https://example.com/board/docs/p1/d/my%20plan/","version_url":"https://example.com/board/docs/p1/d/my%20plan/-/v/2/"}'),
    ).toEqual({
      page: { plugin: "docs", path: "p1/d/my%20plan/-/v/2/", search: "" },
      slug: "my plan",
      version: 2,
    })
    expect(publishedDoc('{"url":"https://example.com/elsewhere"}')).toBeNull()
    expect(publishedDoc("an error")).toBeNull()
  })
})

/** Whether `source` is JavaScript that parses (it fails otherwise): parsed, not run. */
const parses = (source: string) => Effect.promise(() => transformWithOxc(source, "frame.js"))

describe("a plugin's page in its frame", () => {
  const context = { host: "h", plugin: "docs", slot: "page" as const, path: "p1/d/plan", task_id: null }
  const page = frameDocument("<h1>Plan</h1><script>ready()</script>", { vars: "--color-bg:#000", context, base: frameBase(doc), report: false })

  it("loads under the board's frame policy, set before anything of the page's or of the bridge's", () => {
    const policy = page.indexOf(`content="${FRAME_CSP}"`)
    expect(policy).toBeGreaterThan(0)
    expect(policy).toBeLessThan(page.indexOf("<script>"))
    expect(page.indexOf("window.huntaway")).toBeLessThan(page.indexOf("<h1>Plan</h1>"))
    // Its links are followed after its own scripts have had the first say.
    expect(page.indexOf("__huntawayLinks&&")).toBeGreaterThan(page.indexOf("ready()"))
    expect(page).toContain(":root{--color-bg:#000}")
  })

  it.effect("carries scripts that parse", () =>
    Effect.gen(function* () {
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "")
      expect(scripts).toHaveLength(3)
      // Parsed, not run: they are for a page, not for here. (They are text in the app, so nothing else reads them.)
      yield* Effect.forEach([scripts[0] ?? "", scripts[2] ?? "", deliverScript({ iaPluginReply: { id: 1, ok: true, value: "</script>" } })], parses, {
        concurrency: 1,
      })
    }),
  )

  it("gives its scripts arguments that can't close them", () => {
    const sly = frameDocument("", { vars: "", context: { ...context, path: "</script><script>alert(1)</script>" }, base: "", report: true })
    expect(sly).not.toContain("</script><script>alert(1)")
    expect(sly).toContain("overflow:hidden}")
    expect(deliverScript({ iaPluginEvent: { topic: "</script>" } })).not.toContain("</script>")
  })

  it("takes the bridge's messages for what they are, and nothing else", () => {
    expect(frameMessage({ iaPlugin: { kind: "call", id: 3, method: "doc.labels", payload: { a: 1 } } })).toEqual({
      kind: "call",
      id: 3,
      method: "doc.labels",
      payload: { a: 1 },
    })
    expect(frameMessage({ iaPlugin: { kind: "call", id: "3", method: "x" } })).toBeNull()
    expect(frameMessage({ iaPlugin: { kind: "navigate", path: "/docs/p1" } })).toEqual({ kind: "navigate", path: "/docs/p1" })
    // A board path, never another site's.
    expect(frameMessage({ iaPlugin: { kind: "navigate", path: "//example.com/x" } })).toBeNull()
    expect(frameMessage({ iaPlugin: { kind: "navigate", path: "https://example.com" } })).toBeNull()
    expect(frameMessage({ iaPlugin: { kind: "openTask", id: "t1" } })).toEqual({ kind: "openTask", id: "t1" })
    expect(frameMessage({ iaPlugin: { kind: "height", height: 99_999 } })).toEqual({ kind: "height", height: 4000 })
    expect(frameMessage({ iaPlugin: { kind: "scroll", y: 240 } })).toEqual({ kind: "scroll", y: 240 })
    expect(frameMessage({ iaPlugin: { kind: "scroll", y: "240" } })).toBeNull()
    expect(frameMessage({ iaOpen: "https://example.com/" })).toEqual({ kind: "open", url: "https://example.com/" })
    expect(frameMessage({ iaScroll: 12 })).toBeNull()
    expect(frameMessage("text")).toBeNull()
    expect(frameMessage(null)).toBeNull()
  })
})
