// HA-218: a long thread drawn from its items opens at a window of its last items, and loads the pages before it as it's
// scrolled up. Its items are put into the server's database before the page opens it (threads.mjs: `seedThread`); the
// old check served them from the page's side.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { replies, routeRpc, seedBoard, seedThread, startServer, threadScroller, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

test("a long thread drawn from its items loads its earlier items as it's scrolled up", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "A long one", status: "in_review" } })
  // 400 replies: more than a window (300 items) and a page.
  seedThread(server, task, replies(400))
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const calls = await routeRpc(page)
    const asked = () => calls.filter((c) => c.tag.startsWith("threads.")).map((c) => `${c.tag} ${JSON.stringify(c.payload)}`)
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait [data-thread=items]", "wait Reply 399", "gone Reply 50"])
    assert.deepEqual(asked(), [`threads.watch {"task_id":"${task.id}","limit":300}`])
    // Scrolled to the top: the page before the window, which is the rest of it.
    await threadScroller(page).evaluate((el) => (el.scrollTop = 0))
    await ui.run(["wait text=/^Reply 50$/", "wait text=/^Reply 0$/", "gone Load earlier messages"])
    assert.deepEqual(asked(), [`threads.watch {"task_id":"${task.id}","limit":300}`, `threads.page {"task_id":"${task.id}","before":100,"limit":200}`])
  })
})
