// Ports the old confirmErrors check (HA-40): what a refused or concurrent change leaves on the page. Its first case, a
// refused profile delete and a double-click, is settingsPanels.test.mjs's; these are the other two. The old check routed
// `PATCH /tasks/<id>` to a 500 and slept for the server's change to reach the page; this one fails `tasks.update` on the
// RPC socket (routeRpc), and changes the task's title with its preview URL so it can wait for the header to show it.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, failure, makeTask, routeRpc, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

const previewOf = async (task) => (await server.rpc("tasks.get", { id: task.id })).preview_url

// HA-40: the Pull request and Preview fields took the task's value on every change, so typing in one was overwritten when
// the agent set it, and a field that wasn't touched could write an old value back.
test("a task's text field keeps what's typed while the task changes, and follows it once left", async () => {
  const task = await makeTask(server, board.project, { title: "Fields" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const preview = page.locator("input[placeholder^='https://… (where to try']")
    const changed = async (title, url) => {
      await server.rpc("tasks.update", { id: task.id, patch: { title, preview_url: url } })
      await page.locator("header h1", { hasText: title }).waitFor()
    }
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click details", "wait css=input[placeholder^='https://… (where to try']"])
    await preview.click()
    await page.keyboard.type("https://typed.example")
    await changed("Fields changed", "https://agent.example")
    assert.equal(await preview.inputValue(), "https://typed.example")
    await page.keyboard.press("Enter")
    await eventually(async () => assert.equal(await previewOf(task), "https://typed.example", "what was typed is saved"))

    // Focused but not changed: a value set meanwhile isn't written over on leaving, and shows once it's left.
    await preview.click()
    await changed("Fields changed again", "https://agent2.example")
    await page.keyboard.press("Enter")
    await eventually(async () => assert.equal(await preview.inputValue(), "https://agent2.example"))
    assert.equal(await previewOf(task), "https://agent2.example")
    // Nothing old was written back on leaving (a change round the page and back, to let one land if it was sent).
    await server.rpc("tasks.update", { id: task.id, patch: { title: "Fields left" } })
    await page.locator("header h1", { hasText: "Fields left" }).waitFor()
    assert.equal(await previewOf(task), "https://agent2.example")
  })
})

// HA-40: model and effort changes had no .catch, so a refused one looked saved.
test("a refused model change says so", async () => {
  const task = await makeTask(server, board.project, { title: "Model" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await routeRpc(page, (r) =>
      r.tag === "tasks.update" && r.payload?.id === task.id ? failure({ _tag: "Invalid", field: "", reason: "disk full" }) : undefined,
    )
    // In the message box (HA-326).
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click thread"])
    const model = page.locator('button[title="Model"]')
    const pick = async (name) => {
      await model.click()
      await page.getByRole("menuitemradio", { name }).click()
    }
    await pick(/^Opus/)
    await ui.run(["wait Couldn't change the model: disk full"])
    await eventually(async () => assert.match(await model.innerText(), /default|Default model/, "it shows the saved model again"))
    // A specific model typed in: saved on Enter, and refused the same way.
    await pick(/^Specific model/)
    await page.keyboard.type("claude-opus-5-5")
    await page.keyboard.press("Enter")
    await ui.run(["wait Couldn't change the model: disk full"])
    await eventually(async () => assert.match(await model.innerText(), /default|Default model/, "it shows the saved model again"))
  })
})
