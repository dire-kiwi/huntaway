import { assert, describe, it } from "@effect/vitest"
import { toJson } from "../../src/components/ui/json"

// The board's links for what agents publish (the old tests/docs.test.ts, HA-281, HA-321): the documents are the docs
// plugin's (HE-42), at the paths the built-in documents had.

// Only what the links use of a window, and an origin the last test sets.
const location = { pathname: "/", search: "", hash: "", origin: "http://localhost" }
Object.assign(globalThis, { window: { addEventListener() {}, location, history: { pushState() {}, replaceState() {} } } })
const { boardDocLink, publishedDocPath } = await import("../../src/components/task/thread/docLinks")
const { parse } = await import("../../src/router")

/** A tool's result as JSON text. */
const result = (v: object) => toJson(v)

describe("links to the board's documents", () => {
  it("a published document links to the board's own page, not the host's address", () => {
    assert.deepStrictEqual(
      publishedDocPath(
        result({
          slug: "the-plan",
          version: 3,
          url: "http://127.0.0.1:7878/docs/p1/d/the-plan/",
          version_url: "http://127.0.0.1:7878/docs/p1/d/the-plan/-/v/3/",
        }),
      ),
      { path: "/docs/p1/d/the-plan/-/v/3/", slug: "the-plan", version: 3 },
    )
    assert.deepStrictEqual(publishedDocPath(result({ slug: "the-plan", version: 3, url: "http://127.0.0.1:7878/docs/p1/d/the-plan/" })), {
      path: "/docs/p1/d/the-plan/",
      slug: "the-plan",
      version: 3,
    })
    // A public URL with a path of its own, even one with docs in it.
    for (const prefix of ["/board", "/docs", "/a/docs/b"]) {
      const url = `https://example.com${prefix}/docs/p1/d/the-plan/`
      assert.deepStrictEqual(
        publishedDocPath(result({ slug: "the-plan", version: 2, url, version_url: `${url}-/v/2/` })),
        { path: "/docs/p1/d/the-plan/-/v/2/", slug: "the-plan", version: 2 },
        prefix,
      )
    }
    // Another server's documents (a project's own `docs`), and results that aren't JSON, have none.
    assert.isNull(publishedDocPath(result({ url: "https://docs.example.com/d/plan/" })))
    assert.isNull(publishedDocPath("no document"))
    assert.isNull(publishedDocPath("null"))
  })

  it("a message's link to a document is the board's when it's at the board's address or the host's own", () => {
    location.origin = "https://board.example.com"
    const path = "/docs/p1/d/word-round-trip/"
    for (const link of [`http://127.0.0.1:7878${path}`, `https://board.example.com${path}`, `http://localhost:7878${path}`, path]) {
      const found = boardDocLink(link)
      assert.strictEqual(found?.slug, "word-round-trip", link)
      assert.strictEqual(found?.path, path)
    }
    assert.deepStrictEqual(boardDocLink(`http://127.0.0.1:7878${path}-/v/3/p2#h`), { path: `${path}-/v/3/p2#h`, slug: "word-round-trip", version: 3 })
    // Not documents, or not the board's.
    for (const link of [undefined, "", "https://docs.example.com/docs/p1/d/x/", "http://127.0.0.1:7878/docs/p1", "http://127.0.0.1:7878/t/abc", "mailto:a@b.c"])
      assert.isNull(boardDocLink(link), String(link))
  })

  it("opens as the docs plugin's page", () => {
    assert.deepStrictEqual(parse("/docs/p1/d/the-plan/-/v/3/"), { name: "plugin", plugin: "docs", path: "p1/d/the-plan/-/v/3" })
  })
})
