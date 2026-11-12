// Ports the old markdownImages check (HA-262): an image in a task's markdown is a link to it, never loaded.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// HA-262: an image in an agent's markdown was loaded as soon as it was shown, so `![](https://…/?k=<secret>)` sent the
// secret out with nothing to approve. It's a link to the image instead.
test("an image in markdown is a link, and isn't loaded", async () => {
  const src = "https://images.example.invalid/p.png?k=s3cret"
  const task = await makeTask(server, board.project, { title: "Has an image", description: `Look: ![the chart](${src})` })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const fetched = []
    await page.route("https://images.example.invalid/**", (route) => (fetched.push(route.request().url()), route.abort()))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click details", "wait Look:"])
    const link = page.locator(".prose-chat a", { hasText: "the chart" })
    await link.waitFor()
    assert.equal(await link.getAttribute("href"), src)
    assert.equal(await page.locator(".prose-chat img").count(), 0)
    assert.deepEqual(fetched, [])
  })
})
