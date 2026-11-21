// The task view's key items and its Details tab (HE-31), on the demo board (`--demo`, whose task at work has a todo
// list): the column beside the thread has what there is to know about the task, and nothing to set by hand; the Details
// tab has the title and the description, with the rest beside them where there's room.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, startServer, tasksByTitle, updateTask, withBrowser } from "./harness.mjs"

let server, project, tasks
beforeAll(async () => {
  server = startServer("--demo")
  const [profile] = await server.rpc("profiles.list")
  project = (await server.rpc("projects.list", { profile_id: profile.id })).find((p) => p.name === "Demo")
  tasks = await tasksByTitle(server, project)
})
afterAll(() => server?.stop())

const KEY = "css=[data-key-items]"
const DETAILS = "css=[data-details]"
/** The titles of the sections in `scope`, in order. */
const sections = (page, scope) =>
  page.locator(`${scope.slice(4)} section h3, ${scope.slice(4)} section > div:first-child > button[aria-expanded]`).allTextContents()

test("the column beside the thread has the task's key items, and nothing to set by hand", async () => {
  const work = tasks["Something being worked on"]
  const waiting = tasks["A task waiting on an answer"]
  await updateTask(server, work, { pr_url: "https://github.com/acme/demo/pull/12", preview_url: "http://127.0.0.1:9/try", depends_on: [waiting.id] })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${work.id}`, `wait ${KEY}`])
    assert.deepEqual(await sections(page, KEY), ["Status", "Todo list", "Pull request", "Preview", "Depends on"])
    // Its status as a line, not the list to move it with; the whole todo list, where its card has five of the seven.
    assert.equal(await page.locator(`${KEY.slice(4)} [data-status]`).getAttribute("data-status"), "in_progress")
    assert.equal(await page.locator(`${KEY.slice(4)} button`, { hasText: "In review" }).count(), 0)
    assert.equal(await page.locator(`${KEY.slice(4)} [aria-label='Todo list'] li`).count(), 7)
    await ui.run([
      `wait ${KEY} >> text=2/7`,
      `wait ${KEY} >> text=#12`,
      `wait ${KEY} >> text=127.0.0.1:9/try`,
      `wait ${KEY} >> text=A task waiting on an answer`,
    ])
    // Nothing to add a dependency with here, nor the links' fields.
    assert.equal(await page.locator(`${KEY.slice(4)} [role=combobox], ${KEY.slice(4)} input`).count(), 0)
    // A task with none of them has only its status.
    await ui.run([`goto /p/${project.id}?task=${waiting.id}`, `wait ${KEY} >> text=Needs attention`])
    assert.deepEqual(await sections(page, KEY), ["Status"])
  })
})

test("the Details tab has the title and the description, with the rest beside them", async () => {
  const task = tasks["Finished work to look over"]
  await updateTask(server, task, { description: "What was asked for." })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${task.id}`, `wait ${KEY}`, "click Details", `wait ${DETAILS} >> text=What was asked for.`])
    // The key items give way to the rest of the details, the status list first.
    assert.equal(await page.locator(KEY.slice(4)).count(), 0)
    assert.deepEqual(await sections(page, DETAILS), ["Title", "Description"])
    const side = "css=aside:has(h3:text-is('Status'))"
    const beside = await sections(page, side)
    assert.deepEqual(beside.slice(0, 1), ["Status"])
    for (const title of ["Labels", "Depends on", "Preview", "Pull request", "Worktree", "Agent"]) assert.ok(beside.includes(title), `${title} in ${beside}`)
    await ui.run([`wait ${side} >> text=Delete task`])
    // The status list moves it, as it did.
    await page.locator(`${side.slice(4)} section:has(h3:text-is('Status')) button`, { hasText: "Needs attention" }).click()
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).status, "needs_attention"))
    // The composer is under the tab, and a message sent from it shows the thread.
    assert.ok(await page.locator("main textarea").isVisible())
  })
})

test("a task not started opens on its details, and an edit there is kept as the panel expands", async () => {
  const task = tasks["Edit this task's title and description"]
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // Beside the board there's no room for a column: the Details tab is one list, with the status first.
    await ui.run([`goto /p/${project.id}?task=${task.id}&side`, `wait ${DETAILS}`])
    assert.deepEqual((await sections(page, DETAILS)).slice(0, 3), ["Status", "Title", "Description"])
    await ui.run([
      "click Edit description",
      "press Control+a",
      "type A draft to keep",
      "click Expand into a dialog",
      `wait css=aside:has(h3:text-is('Status'))`,
    ])
    assert.deepEqual(await sections(page, DETAILS), ["Title", "Description"])
    assert.equal(await page.locator(`${DETAILS.slice(4)} textarea`).inputValue(), "A draft to keep")
    // In the dialog, as a task opens, it's on its details too.
    await ui.run([`goto /p/${project.id}?task=${task.id}`, `wait ${DETAILS} >> text=Description`])
    assert.equal(await page.locator(KEY.slice(4)).count(), 0)
  })
})
