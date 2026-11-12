// Ports the old completeMenu check (IA-53): completing a task from its card's right-click menu. The old check failed the
// save with a routed 400 on `PATCH /tasks/<id>`; this one fails `tasks.update` on the RPC socket (routeRpc).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, failure, routeRpc, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const TITLE = "Try dragging this card to another column"
// The heading of the board column a card is in.
const columnOf = (page, title) =>
  page.evaluate((t) => {
    const card = [...document.querySelectorAll("[data-task]")].find((c) => c.textContent.includes(t))
    return card?.closest("section")?.querySelector("span.font-medium")?.textContent
  }, title)

// IA-53: completing a task from its right-click menu moves it to Done at once, and puts it back if the save fails.
test("a failed complete from the card menu shows the error and puts the card back", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    let failing = true
    await routeRpc(page, (r) => (r.tag === "tasks.update" && failing ? failure({ _tag: "Invalid", field: "status", reason: "nope" }) : undefined))
    await ui.run([`goto /p/${board.project.id}`, `wait ${TITLE}`])
    const before = await columnOf(page, TITLE)
    assert.ok(before)
    await ui.run([`rclick ${TITLE}`, "wait [role=menu]", "click [role=menu] >> text=Won't fix", "wait nope", "gone [role=menu]"])
    await eventually(async () => assert.equal(await columnOf(page, TITLE), before))
    assert.equal((await tasksByTitle(server, board.project))[TITLE].status, "todo")

    // Without the failure it's done, with the resolution picked.
    failing = false
    await ui.run([`rclick ${TITLE}`, "click [role=menu] >> text=Not done", "gone [role=menu]", "gone nope"])
    await eventually(async () => {
      const t = (await tasksByTitle(server, board.project))[TITLE]
      assert.deepEqual([t.status, t.resolution], ["done", "not_done"])
    })
  })
})
