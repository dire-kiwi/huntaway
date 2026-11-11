// Where the task panel sits beside the board on a fresh load of `/p/<project>?task=<id>`: against the window's right
// edge, half the board's width (at least 480), with its close button on screen. Screenshots taken part way through its
// slide-in showed it cut off at the right edge, as if it were too wide; once in place it fits at any width.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, [{ title: "A task in the panel" }])
})
afterAll(() => server?.stop())

for (const [size, width] of [
  ["1900x1000", 830],
  ["900x700", 480],
]) {
  test(`the panel and its close button are within a ${size} window on first load`, async () => {
    await withBrowser(server, { size }, async (ui) => {
      const { page } = ui
      await ui.run([`goto /p/${board.project.id}?task=${board.tasks[0].id}`, "wait css=h1:has-text('A task in the panel')"])
      const box = await page.evaluate(() => {
        const close = document.querySelector("[title='Close (Esc)']").getBoundingClientRect()
        const panel = document.querySelector("[title='Close (Esc)']").closest(".animate-slide-in-right").getBoundingClientRect()
        return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, panel: [panel.left, panel.right], close: [close.left, close.right] }
      })
      assert.equal(box.scroll, box.viewport)
      assert.equal(box.panel[1], box.viewport)
      assert.equal(box.panel[1] - box.panel[0], width)
      assert.ok(box.close[0] >= box.panel[0] && box.close[1] <= box.viewport, JSON.stringify(box))
    })
  })
}
