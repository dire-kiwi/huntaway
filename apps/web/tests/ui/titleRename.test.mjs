// Renaming a task from its panel's title, its card's menu and its details (IA-126, HA-100), from the old titleRename
// check. A change made elsewhere comes as the task's event (`tasks.update`, as a refresh from the user's messages does).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const newTask = (title) => server.rpc("tasks.create", { task: { project_id: board.project.id, title } })
const update = (task, patch) => server.rpc("tasks.update", { id: task.id, patch })

/** The task's title and whether it's pinned, once its title is no longer `old`, as the server has them. */
const savedTitle = (task, old) =>
  eventually(async () => {
    const saved = await server.rpc("tasks.get", { id: task.id })
    assert.notEqual(saved.title, old)
    return [saved.title, saved.title_pinned]
  })

// IA-126: a title re-titled from a message while it was being renamed replaced what was typed, and Enter saved it.
test("a title that changes while it's being renamed keeps the draft", async () => {
  const task = await newTask("Old name")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "dblclick css=h1[title='Double-click to rename']",
      "press Control+a",
      "type My preferred title",
    ])
    // As a refresh from the user's messages changes it: a new title that isn't pinned.
    await update(task, { title: "Refresh result", title_pinned: false })
    await ui.run(["wait Refresh result"])
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").inputValue(), "My preferred title")
    await ui.run(["press Enter"])
    assert.deepEqual(await savedTitle(task, "Refresh result"), ["My preferred title", true])
    // Not being edited, it follows the task again.
    await update(task, { title: "Another refresh", title_pinned: false })
    await ui.run(["wait css=h1:has-text('Another refresh')", "dblclick css=h1[title='Double-click to rename']"])
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").inputValue(), "Another refresh")
  })
})

// IA-126: the rename field stayed open with its draft when the panel moved to another task, and Enter renamed that one.
test("a rename doesn't follow the panel to another task", async () => {
  const a = await newTask("First task")
  const b = await newTask("Second task")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${board.project.id}?task=${a.id}`,
      "wait css=h1:has-text('First task')",
      `click css=[data-task='${b.id}']`,
      "wait css=h1:has-text('Second task')",
    ])
    await ui.run(["dblclick css=h1[title='Double-click to rename']", "press Control+a", "type Draft for second task"])
    await page.goBack()
    await ui.run(["wait css=h1:has-text('First task')"])
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").count(), 0)
    await ui.run(["press Enter"])
    // Nothing renamed: what a rename would have saved has had time to (the card shows the event), and hasn't.
    await page.locator(`[data-task="${a.id}"]`).getByText("First task").waitFor()
    const titles = await Promise.all([a, b].map(async (t) => (await server.rpc("tasks.get", { id: t.id })).title))
    assert.deepEqual(titles, ["First task", "Second task"])
  })
})

// HA-100: a card's right-click menu sets its title in a dialog, which pins it.
test("Set title… in a card's menu renames the task", async () => {
  const task = await newTask("Named by its prompt")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "rclick Named by its prompt", "click [role=menu] >> text=Set title…", "wait [role=dialog]"])
    assert.equal(await page.locator("[role=dialog] input[aria-label=Title]").inputValue(), "Named by its prompt")
    await ui.run(["press Control+a", "type Named from the menu", "press Enter", "gone [role=dialog]", "wait Named from the menu"])
    assert.deepEqual(await savedTitle(task, "Named by its prompt"), ["Named from the menu", true])
  })
})

// HA-100: the task's details have its title, to rename and to unpin.
test("the details' Title section renames and unpins the title", async () => {
  const task = await newTask("Before the details")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const section = "css=section:has(h3:text-is('Title'))"
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Details", "click Edit title", "press Control+a", "type Renamed in the details"])
    // Escape leaves the panel open, and the title as it was.
    await ui.run(["press Escape", `gone ${section} >> input`, "click Edit title"])
    assert.equal(await page.locator(`${section.slice(4)} input`).inputValue(), "Before the details")
    await ui.run(["press Control+a", "type Renamed in the details", "press Enter", `wait ${section} >> text=Set by hand`])
    assert.deepEqual(await savedTitle(task, "Before the details"), ["Renamed in the details", true])
    await ui.run([`click ${section} >> text=Unpin`, `gone ${section} >> text=Set by hand`])
    await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).title_pinned, false))
  })
})
