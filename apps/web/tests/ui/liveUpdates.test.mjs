import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { column, DEMO_TASKS, eventually, makeTask, seedBoard, startServer, tasksByTitle, updateTask, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

// The board is live (board.watch): a change made anywhere (another tab, an agent, a script) shows without a reload.
// The old liveUpdates check drove the thread's streamed text and a subproject's progress over an intercepted socket;
// those come with threads (M2). This is its board half: cards follow their tasks' events.
test("a task made, changed or deleted elsewhere shows on the board without a reload", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on"])
    const made = await makeTask(server, board.project, { title: "Made by a script", status: "in_review" })
    await column(page, "In review").getByText("Made by a script").waitFor()
    await updateTask(server, made, { title: "Renamed by a script", status: "needs_attention" })
    await column(page, "Needs attention").getByText("Renamed by a script").waitFor()
    await server.rpc("tasks.delete", { id: made.id })
    await ui.run(["gone Renamed by a script"])
  })
})

// Two tabs on the board: what one does, the other shows (each tab has its own connection and board).
test("a second tab sees a task moved and created in the first", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page, context } = ui
    const other = await context.newPage()
    await other.goto(`${server.url}/p/${board.project.id}`)
    await other.getByText("Try dragging this card to another column").waitFor()
    await ui.run([`goto /p/${board.project.id}`, "wait Try dragging this card to another column"])

    // Dragged to In progress in the first tab: the second follows.
    await page.locator("[data-task]", { hasText: "Try dragging this card" }).dragTo(column(page, "In progress"))
    await column(other, "In progress").getByText("Try dragging this card to another column").waitFor()
    await eventually(async () => assert.equal((await tasksByTitle(server, board.project))["Try dragging this card to another column"].status, "in_progress"))

    // Made in the second tab: the first shows it.
    await other.getByRole("button", { name: "New task" }).first().click()
    await other.keyboard.type("Made in the other tab")
    await other.keyboard.press("Control+Enter")
    await column(page, "To do").getByText("Made in the other tab").waitFor()
    await other.close()
  })
})
