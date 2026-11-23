import { assert, describe, it } from "@effect/vitest"
import { onTaskHost } from "../../src/components/task/thread/forwardPort"

// HE-92: Forward port is for a client on another machine, so the banner leaves it out on the task's host itself.
describe("onTaskHost", () => {
  it("is the page's own host opened on loopback", () => {
    for (const hostname of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) assert.isTrue(onTaskHost("h1", "h1", hostname), hostname)
  })

  it("is not a linked host's task, even on loopback", () => {
    assert.isFalse(onTaskHost("h2", "h1", "localhost"))
  })

  it("is not a page opened on another address, or before the board says its host", () => {
    assert.isFalse(onTaskHost("h1", "h1", "omarchy.tail1234.ts.net"))
    assert.isFalse(onTaskHost("h1", "h1", "192.168.1.5"))
    assert.isFalse(onTaskHost("h1", null, "localhost"))
  })
})
