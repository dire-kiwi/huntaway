import { assert, describe, it } from "@effect/vitest"
import { pluginHost } from "../../src/components/plugins/pluginHost"

// HE-60: a plugin's page whose path starts with a profile's id (a document's, `/docs/<profile id>/d/<slug>`) is that
// profile's host's, so a document of a host the hub links opens there rather than on the hub, which has no such profile.

const profile = (id: string, host_id: string) => ({ id, host_id })
const board = (loaded: boolean, ...profiles: ReadonlyArray<{ id: string; host_id: string }>) => ({ loaded, localHostId: "hub", profiles })

describe("a plugin page's host", () => {
  it("is the host of the profile the path starts with", () => {
    const b = board(true, profile("p-hub", "hub"), profile("p-laptop", "laptop"))
    assert.strictEqual(pluginHost(b, "p-laptop/d/plan"), "laptop")
    assert.strictEqual(pluginHost(b, "p-hub/d/plan"), "hub")
  })

  it("is the page's own host where two hosts have that profile", () => {
    assert.strictEqual(pluginHost(board(true, profile("p", "laptop"), profile("p", "hub")), "p/d/plan"), "hub")
  })

  it("is the page's own host for a path that names no profile, once the board is loaded", () => {
    const b = board(true, profile("p", "laptop"))
    assert.strictEqual(pluginHost(b, ""), "hub")
    assert.strictEqual(pluginHost(b, "other/d/plan"), "hub")
  })

  it("waits while a host that has the profile may not have sent its board yet", () => {
    assert.strictEqual(pluginHost(board(false, profile("p", "hub")), "q/d/plan"), null)
    assert.strictEqual(pluginHost(board(false, profile("q", "laptop")), "q/d/plan"), "laptop")
    assert.strictEqual(pluginHost(board(false), ""), "hub")
  })
})
