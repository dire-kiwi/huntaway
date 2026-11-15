// Where the task panel sits beside the board on a fresh load of `/p/<project>?task=<id>&side`: against the window's right
// edge, half the board's width (at least 480), with its close button on screen. Screenshots taken part way through its
// slide-in showed it cut off at the right edge, as if it were too wide; once in place it fits at any width.
// HE-30: a task opens in a dialog over the board, which collapses into that panel and expands back.
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
      await ui.run([`goto /p/${board.project.id}?task=${board.tasks[0].id}&side`, "wait css=h1:has-text('A task in the panel')"])
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

test("a task opens in a dialog over the board, which collapses into the side panel and back", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const id = board.tasks[0].id
    // A dialog is fixed over the page; the side panel slides in beside the board.
    const panelOf = () =>
      page.evaluate(() => {
        const close = document.querySelector("[title='Close (Esc)']")
        return close.closest(".animate-slide-in-right") ? "side" : close.closest(".fixed.inset-3") ? "dialog" : "neither"
      })
    await ui.run([`goto /p/${board.project.id}`, `click css=[data-task='${id}']`, "wait css=h1:has-text('A task in the panel')"])
    assert.equal(new URL(page.url()).search, `?task=${id}`)
    assert.equal(await panelOf(), "dialog")
    await ui.run(["click Collapse into the side panel", "wait role=button[name='Expand into a dialog']"])
    assert.equal(new URL(page.url()).search, `?task=${id}&side`)
    assert.equal(await panelOf(), "side")
    await ui.run(["click Expand into a dialog", "wait role=button[name='Collapse into the side panel']", "press Escape", "gone Close (Esc)"])
    assert.equal(new URL(page.url()).search, "")
  })
})
