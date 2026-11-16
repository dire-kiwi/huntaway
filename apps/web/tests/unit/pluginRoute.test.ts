import { assert, describe, it } from "@effect/vitest"
import { href, parse } from "../../src/router"

// HE-34: a plugin's pages are at `/<plugin id>/<path>` (docs/plan/15-plugins.md, Pages): a first segment that isn't one
// of the board's own and could be a plugin's id.

describe("a plugin's page", () => {
  it("is any first segment that could be a plugin's id, with the rest as its path", () => {
    assert.deepStrictEqual(parse("/notes"), { name: "plugin", plugin: "notes", path: "" })
    assert.deepStrictEqual(parse("/notes/p1/d/a%20b/"), { name: "plugin", plugin: "notes", path: "p1/d/a b" })
    assert.strictEqual(href({ name: "plugin", plugin: "notes", path: "p1/d/a b" }), "/notes/p1/d/a%20b")
    // HE-42: the documents are the docs plugin's.
    assert.deepStrictEqual(parse("/docs/p1"), { name: "plugin", plugin: "docs", path: "p1" })
  })

  it("isn't one of the board's own pages, nor what can't be a plugin's id", () => {
    assert.strictEqual(parse("/settings/plugins").name, "settings")
    assert.strictEqual(parse("/t/abc").name, "task")
    assert.deepStrictEqual(parse("/Notes"), { name: "home" })
    assert.deepStrictEqual(parse("/1notes"), { name: "home" })
  })
})
