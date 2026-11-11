import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, [
    { title: "First card", status: "todo" },
    { title: "Second card", status: "todo" },
  ])
})
afterAll(() => server?.stop())

/** The ids of the To do column's cards, top to bottom. */
const todoCards = (page) => page.locator('section[data-status="todo"] [data-task]').evaluateAll((cards) => cards.map((c) => c.dataset.task))

/**
 * Drags the To do column's card `which` over the top half of its card `onto` and drops it there, as a mouse would:
 * several dragover events with renders between them (the drop line is React state), then the drop.
 */
async function dragOnto(page, which, onto) {
  const fire = (types) =>
    page.evaluate(
      ([from, to, events]) => {
        const cards = [...document.querySelectorAll('section[data-status="todo"] [data-task]')]
        const [src, target] = [cards[from], cards[to]]
        const dt = new DataTransfer()
        dt.setData("text/task-id", src.dataset.task)
        const r = target.getBoundingClientRect()
        for (const type of events) {
          const el = type === "dragstart" || type === "dragend" ? src : target
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 4 }))
        }
      },
      [which, onto, types],
    )
  await fire(["dragstart", "dragenter", "dragover"])
  await page.waitForTimeout(150)
  await fire(["dragover"])
  await page.waitForTimeout(150)
  await fire(["drop", "dragend"])
  await page.waitForTimeout(600)
}

// HA-32: a card dropped on its own top half (the drop line shows above it, so it looks like "stay") went to the end of
// the column, with a position update sent: the card dragged is left out of the column the drop position is worked out
// in, so "before itself" was nowhere.
test("a card dropped on itself stays where it is", async () => {
  // A third card, so the one in the middle has cards on both sides.
  await makeTask(server, board.project, { title: "Third card" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Third card"])
    const before = await todoCards(page)
    assert.equal(before.length, 3)
    const saved = await tasksByTitle(server, board.project)

    await dragOnto(page, 1, 1)
    assert.deepEqual(await todoCards(page), before, "the order after a self-drop")
    // Nothing was saved: no task changed on the server (the old check counted PATCH requests; calls go over the socket now).
    const after = await tasksByTitle(server, board.project)
    for (const [title, t] of Object.entries(saved)) assert.equal(after[title].updated_at, t.updated_at, `${title} is unchanged`)

    // The same drag onto another card moves it, so the drop above proves something.
    await dragOnto(page, 1, 0)
    assert.deepEqual(await todoCards(page), [before[1], before[0], before[2]])
    const moved = await tasksByTitle(server, board.project)
    const order = Object.values(moved)
      .filter((t) => t.status === "todo")
      .toSorted((a, b) => a.position - b.position)
      .map((t) => t.id)
    assert.deepEqual(order, [before[1], before[0], before[2]], "a real move is saved")
  })
})
