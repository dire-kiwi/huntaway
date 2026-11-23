// Interactive replies (HE-77): an agent's `<a2ui>` block is drawn in the thread with the board's controls, a click goes
// back to the agent as the user's message, and the agent's update of the surface replaces the earlier copy. The fake
// agent answers "fake-a2ui" with a form (surface "fake-form"), "fake-a2ui-modal" with a Modal (surface "fake-modal"),
// and a click with that surface updated.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedAgentBoard(server)
})
afterAll(() => server?.stop())

test("an interactive reply is drawn, a click reaches the agent, and its update replaces the surface", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "A2UI: form", status: "in_review" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait No agent has worked on this yet"])
    await ui.run(["click css=textarea", "type Show me a form fake-a2ui", "press Enter"])

    // The form, in the board's controls, with the Markdown around it; the Express source isn't shown.
    const form = page.locator("[data-a2ui-surface='fake-form']")
    await form.getByText("Name the task").waitFor()
    await page.getByText("Pick one.").waitFor()
    assert.equal(await page.getByText('surface("fake-form")').count(), 0)
    const title = form.getByRole("textbox", { name: "Title" })
    assert.equal(await title.inputValue(), "A title")

    await title.fill("Ship it")
    await form.getByRole("button", { name: "Save" }).click()

    // The click is the user's message, shown as the click; what it sent is behind it.
    const clicked = page.locator("[data-a2ui-action='fake-form']")
    await clicked.getByText("Clicked “Save”").waitFor()
    await clicked.getByRole("button").click()
    await clicked.getByText("title: Ship it").waitFor()

    // The agent's update draws in its reply, and the first copy says so.
    await page.getByText('Got {"name":"save","context":{"title":"Ship it"}}').waitFor()
    await page.getByText("Interactive reply updated below").waitFor()
    assert.equal(await page.locator("[data-a2ui-surface='fake-form']").count(), 1)

    // A click joined with typed text in one message (as messages queued while a run is busy are): both show, and the
    // fence doesn't.
    const joined = 'Clicked “Skip”\n\n```a2ui-action\n{"surfaceId":"fake-form","name":"skip","sourceComponentId":"x","context":{}}\n```\n\nalso rename it'
    await server.rpc("tasks.send", { id: task.id, text: joined })
    await page.locator("[data-a2ui-action='fake-form']", { hasText: "Clicked “Skip”" }).waitFor()
    // While the run from the click before is still going, the message waits in the composer's queue as it was typed
    // (the fence too) until the agent takes it: once it has, it's in the thread alone.
    await eventually(async () => assert.equal(await page.getByText("also rename it").count(), 1), 15000)
    assert.equal(await page.getByText('"sourceComponentId":"x"').count(), 0)
    await ui.run([`shot ${process.env.TMPDIR ?? "/tmp"}/a2ui-form.png`])
  })
})

test("a Modal's trigger only opens it, and its fields and button work (HE-77 review)", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "A2UI: modal", status: "in_review" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "wait No agent has worked on this yet"])
    await ui.run(["click css=textarea", "type Show me a dialog fake-a2ui-modal", "press Enter"])

    const surface = page.locator("[data-a2ui-surface='fake-modal']")
    await surface.getByRole("button", { name: "Details" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.locator("[data-a2ui-modal]").waitFor()
    // Opening sent nothing: the surface isn't locked and no click is in the thread.
    assert.equal(await page.locator("[data-a2ui-action]").count(), 0)
    assert.equal(await surface.locator("[inert]").count(), 0)

    await dialog.getByRole("textbox", { name: "Note" }).fill("Looks good")
    await dialog.getByRole("button", { name: "Save note" }).click()
    // The click went, the dialog closed with the surface's lock, and the agent's update came.
    await page.locator("[data-a2ui-action='fake-modal']").getByText("Clicked “Save note”").waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.getByText('Got {"name":"note","context":{"note":"Looks good"}}').waitFor()
  })
})
