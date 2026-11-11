import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, seedBoard, startServer, updateTask, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

// HA-5: the board's Graph view shows its tasks, and the view picked stays. (Its Triage view shows each task's last reply
// and a composer: it comes with threads, M2, and the old check's Triage half with it.)
test("the graph view shows the board's tasks, and the view picked stays", async () => {
  const first = board.tasks.find((t) => t.title === "Try dragging this card to another column")
  const second = board.tasks.find((t) => t.title === "Edit this task's title and description")
  await updateTask(server, second, { depends_on: [first.id] })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Merged and closed"])

    // Graph: the task that waits for another follows it, and the rest are listed apart.
    await ui.run(["click Graph view", "wait Not linked to other tasks", "wait Finished work to look over"])
    await page.waitForFunction(() => document.querySelectorAll("path[marker-end='url(#arrow-depends)']").length === 1)

    // The view is kept for the next visit.
    await ui.run([`goto /p/${board.project.id}`, "wait Not linked to other tasks", "click Board view", "wait Merged and closed"])
  })
})

// Clients that last used a removed view should still get a usable board.
for (const view of ["live", "timeline"]) {
  test(`saved ${view} view falls back to Board`, async () => {
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui
      await page.addInitScript((saved) => localStorage.setItem("ia.boardView", saved), view)
      await ui.run([`goto /p/${board.project.id}`, "wait Merged and closed"])
      assert.equal(await page.getByTitle(/^Live view/).count(), 0)
      assert.equal(await page.getByTitle(/^Timeline view/).count(), 0)
      await ui.run(["click List view", "wait Merged and closed", "click Board view", "wait Merged and closed"])
    })
  })
}
