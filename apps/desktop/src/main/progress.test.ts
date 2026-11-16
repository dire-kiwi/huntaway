import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { serverStep } from "./progress.ts"
import { progressPage, progressScript } from "./progressPage.ts"

describe("the progress page", () => {
  it("says each of the server's steps, with its share where it's known", () => {
    assert.deepStrictEqual(serverStep({ step: "backup", done: 0, total: 1.6e9, file: "/b.db" }, 0.4e9), {
      step: "Backing up the database",
      detail: "0.4 GB of 1.6 GB, so that it can go back if the new version is no good",
      share: 0.25,
    })
    // The copy may come out bigger than the pages in use were.
    assert.strictEqual(serverStep({ step: "backup", total: 1000 }, 5000).share, 1)
    assert.deepStrictEqual(serverStep({ step: "migrate", done: 2, total: 3 }), { step: "Updating the database", detail: "3 of 3", share: 2 / 3 })
    assert.deepStrictEqual(serverStep({ step: "start" }), { step: "Starting the board", detail: null, share: null })
    // A step from a newer server.
    assert.strictEqual(serverStep({ step: "reindex", done: 1, total: 2 }).step, "Starting the server")
  })

  it.effect("puts what the server printed in the page only as text, which can't end its script", () =>
    Effect.gen(function* () {
      const state = { heading: "Starting Huntaway", step: "Starting the server", detail: null, share: null, log: ["</script><script>alert(1)</script>"] }
      const script = yield* progressScript(state)
      assert.notInclude(script, "</script>")
      assert.include(script, "\\u003c/script>")
      const page = decodeURIComponent((yield* progressPage(state)).slice("data:text/html;charset=utf-8,".length))
      assert.strictEqual(page.split("</script>").length, 2)
      assert.include(page, "don't reload or close this window")
      assert.notInclude(page, "innerHTML")
    }),
  )
})
