// A context menu stays open while the thread scrolls (HA-32), unless it's on something the scroll moves (HA-49): the old
// contextMenuScroll check, on a board seeded as the old demo board was. Its long thread is written into the server's
// database (`seedThread`) where the old check served it from the page's side (`routeThread`).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, seedBoard, seedThread, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const CARD = "Try dragging this card to another column"

/** A thread long enough to scroll. */
const steps = () =>
  Array.from({ length: 80 }, (_, i) => ({
    id: `legacy:${i + 1}:0`,
    type: "assistant_message",
    text: `Step ${i + 1} of the job.`,
    created_at: new Date(Date.UTC(2026, 9, 27, 7, 0, i)).toISOString(),
  }))

/** Two frames, for scroll events (sent with the next frame) to be handled. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

// HA-32 kept a menu open while the thread follows its agent (data-autoscroll). HA-49: but not one on something that scrolls
// with the thread, which would be left behind.
test("a context menu stays open while the thread scrolls, unless it's on something the scroll moves", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Long job" } })
  seedThread(server, task, steps())
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Thread", "wait Step 80 of the job.", `rclick ${CARD}`, "wait [role=menu]"])
    const thread = page.locator("[data-autoscroll]")
    assert.ok(await thread.evaluate((el) => el.scrollHeight > el.clientHeight + 200), "the thread scrolls")

    // The thread following its agent, as follow() does.
    for (const to of [0, 1e6]) {
      await thread.evaluate((el, top) => (el.scrollTop = top), to)
      await frames(page)
      assert.equal(await page.locator("[role=menu]").count(), 1, `menu closed by the thread scrolling to ${to}`)
    }
    // And the user scrolling it by hand.
    await thread.hover()
    await page.mouse.wheel(0, -600)
    await frames(page)
    assert.equal(await page.locator("[role=menu]").count(), 1, "menu closed by a wheel over the thread")
    await ui.run(["press Escape", "gone [role=menu]"])

    // A menu on something inside a scroller marked data-autoscroll (the board's column here: the thread has no menus
    // of its own yet) closes when that scrolls.
    const column = page.locator(`section:has-text("${CARD}") .overflow-y-auto`).first()
    await column.evaluate((el) => el.setAttribute("data-autoscroll", ""))
    await ui.run([`rclick ${CARD}`, "wait [role=menu]"])
    await column.evaluate((el) => el.dispatchEvent(new Event("scroll")))
    await ui.run(["gone [role=menu]"])
  })
})
