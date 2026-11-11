import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, makeTask, seedBoard, startServer, tasksByTitle, updateTask, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
  // Done three days ago: past the two days that archive a task.
  const old = await makeTask(server, board.project, { title: OLD, status: "done" })
  await updateTask(server, old, { done_at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() })
})
afterAll(() => server?.stop())

const OLD = "Shipped last week"
const RECENT = "Merged and closed"

// IA-142: tasks done for two days leave the kanban board's Done column for the list view's Archived section,
// and dragging one back into Done brings it back.
test("tasks done for two days are archived, in the list view only", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, `wait ${RECENT}`, "wait 1 archived", `gone ${OLD}`])

    // The Done column links to them, in the list view's Archived section, which starts collapsed.
    await ui.run(["click 1 archived", `wait ${OLD}`, "click List view"])
    await ui.run(["click css=#archived-tasks button", `gone ${OLD}`, `goto /p/${board.project.id}`, "wait css=#archived-tasks", `gone ${OLD}`])
    await ui.run(["click css=#archived-tasks button", `wait ${OLD}`, `goto /p/${board.project.id}`, `wait ${OLD}`])
    assert.match(await page.locator("#archived-tasks").textContent(), /^Archived1/)

    // Dragged into Done, it's done from now on.
    await page.locator("[data-task]", { hasText: OLD }).dragTo(page.locator("[data-task]", { hasText: RECENT }))
    await page.waitForFunction(() => (document.querySelector("#archived-tasks")?.textContent ?? "").startsWith("Archived0"))
    const done = await eventually(async () => {
      const t = (await tasksByTitle(server, board.project))[OLD]
      assert.ok(Date.now() - Date.parse(t.done_at) < 60_000, t.done_at)
      return t
    })
    assert.equal(done.status, "done")
    await ui.run(["click Board view", `wait ${OLD}`, "gone 1 archived"])
  })
})
