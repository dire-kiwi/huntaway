import { assert, describe, it } from "@effect/vitest"
import { cameFrom, stateFrom } from "../../src/router"

// HE-86: a plugin's page (a document) links back to the board's page it was opened from.

describe("where a plugin's page was opened from", () => {
  it("is the page before it, kept while moving between the plugin's own pages", () => {
    assert.strictEqual(cameFrom("/docs/p1/d/plan", "/p/x?task=t1", null, false), "/p/x?task=t1")
    assert.strictEqual(cameFrom("/docs/p1/d/plan/-/v/2", "/docs/p1/d/plan", "/t/t1", false), "/t/t1")
    assert.strictEqual(cameFrom("/docs/p1", "/docs/p1/d/plan?modal=t2", "/t/t1", false), "/t/t1")
    // Opened from another plugin's page, that is where it came from.
    assert.strictEqual(cameFrom("/docs/p1", "/notes/p1", "/settings", false), "/notes/p1")
  })

  it("is kept by a redirect, and is nothing off the plugin's pages", () => {
    assert.strictEqual(cameFrom("/docs/p1/d/plan/", "/docs/p1/d/old", "/guide", true), "/guide")
    assert.strictEqual(cameFrom("/docs/p1", "/t/t1", null, true), null)
    assert.strictEqual(cameFrom("/p/x", "/docs/p1", "/t/t1", false), null)
    assert.strictEqual(cameFrom("/settings/plugins", "/docs/p1", "/t/t1", false), null)
  })

  it("is read from a history entry's state", () => {
    assert.strictEqual(stateFrom({ from: "/t/t1" }), "/t/t1")
    assert.strictEqual(stateFrom(null), null)
    assert.strictEqual(stateFrom({ from: 1 }), null)
  })
})
