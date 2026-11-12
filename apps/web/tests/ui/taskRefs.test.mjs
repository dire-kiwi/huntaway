// Ports the old taskRefs check (HA-307, HA-326): a task's key in markdown opens that task in a dialog over the board.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// HA-307: a task's key in markdown (an agent's message, a description) opens that task; since HA-326 in a dialog over the
// page, which leaves the side panel's task as it was.
test("a task key in markdown opens its task in a dialog over the board", async () => {
  const { project } = board
  const target = await makeTask(server, project, { title: "The one referred to" })
  const key = `${project.key}-${target.number}`
  const task = await makeTask(server, project, { title: "Refers to another", description: `See ${key}, not ${project.key}-9999 or \`${key}\`.` })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click details", "wait See"])
    const links = page.locator(".prose-chat a")
    await links.first().waitFor()
    assert.deepEqual(await links.allTextContents(), [key], "only the key of a task there is is a link")
    await links.first().click()
    await page.waitForURL((u) => u.searchParams.get("modal") === target.id)
    const url = new URL(page.url())
    assert.equal(url.pathname, `/p/${project.id}`, "it opens over the same board")
    assert.equal(url.searchParams.get("task"), task.id, "with the side panel's task still open")
    await ui.run(["wait css=[data-task-modal] >> text=The one referred to"])
    // Escape closes the dialog only.
    await ui.run(["press Escape", "gone css=[data-task-modal]", "wait Refers to another"])
    assert.equal(new URL(page.url()).searchParams.get("task"), task.id)
  })
})
