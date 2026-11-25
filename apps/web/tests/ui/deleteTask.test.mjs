// Deleting a task from its details (the old deleteTask check, HA-32): a deletion that fails says why and keeps the
// dialog open. The old check answered the REST `DELETE /tasks/<id>` with a 409; this answers `tasks.delete` with the
// `Conflict` the server gives a task that is merging.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, makeTask, routeRpc, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

// HA-32: a deletion that failed (the host offline, or a conflict while the task merges) closed the dialog and the panel
// as if it had worked, leaving the task on the board with no word of why.
test("a deletion that fails says so and keeps the dialog open", async () => {
  const task = await makeTask(server, board.project, { title: "Stays put" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await routeRpc(page, (r) => (r.tag === "tasks.delete" ? failure({ _tag: "Conflict", reason: "merging", detail: "the task is being merged" }) : undefined))
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Delete task", "wait This stops any running agent"])
    await page.getByRole("button", { name: /^Delete$/ }).click()
    await ui.run(["wait the task is being merged"])
    assert.ok(await page.getByRole("button", { name: /^Delete$/ }).isVisible(), "the dialog stays open")
    assert.equal((await server.rpc("tasks.get", { id: task.id })).title, "Stays put")
  })
})

const card = (t) => `[data-task="${t.id}"]`

// HE-109: a card's right-click menu deletes it, once asked, and the board stays where it is (closing the side panel only
// where that showed it).
test("a card's menu deletes the task, closing the panel that showed it", async () => {
  const kept = await makeTask(server, board.project, { title: "Kept open" })
  const gone = await makeTask(server, board.project, { title: "Deleted from its card" })
  const open = await makeTask(server, board.project, { title: "Deleted while open" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${kept.id}&side`, `wait ${card(gone)}`, `rclick ${card(gone)}`, "click role=menuitemradio[name='Delete…']"])
    await ui.run(["wait This stops any running agent", "click role=dialog >> role=button[name='Delete']", "gone role=dialog", `gone ${card(gone)}`])
    assert.match(new URL(page.url()).search, new RegExp(`task=${kept.id}`), "the panel on another task stays open")

    await ui.run([`goto /p/${board.project.id}?task=${open.id}&side`, `wait ${card(open)}`, `rclick ${card(open)}`, "click role=menuitemradio[name='Delete…']"])
    await ui.run(["click role=dialog >> role=button[name='Delete']", `gone ${card(open)}`])
    assert.equal(new URL(page.url()).pathname, `/p/${board.project.id}`)
    assert.doesNotMatch(new URL(page.url()).search, /task=/, "its panel closed")
    await assert.rejects(server.rpc("tasks.get", { id: gone.id }))
  })
})
