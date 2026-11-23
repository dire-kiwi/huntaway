import { assert, describe, it } from "@effect/vitest"
import { onTaskHost } from "../../src/components/task/thread/forwardPort"

// HE-92: Forward port is for a client on another machine, so the banner leaves it out in the desktop app on the task's
// host itself. `appServerHere` is whether the app's board server runs on this machine (no `serverUrl`).
describe("onTaskHost", () => {
  it("is the desktop app on its own server's machine, for that server's task", () => {
    assert.isTrue(onTaskHost("h1", "h1", true))
  })

  it("is not a linked host's task, even in the app on its own server's machine", () => {
    assert.isFalse(onTaskHost("h2", "h1", true))
  })

  it("is not the app with a serverUrl (a remote server, or a tunnel at localhost), nor a browser", () => {
    assert.isFalse(onTaskHost("h1", "h1", false))
  })

  it("is not before the board says its host", () => {
    assert.isFalse(onTaskHost("h1", null, true))
  })
})
