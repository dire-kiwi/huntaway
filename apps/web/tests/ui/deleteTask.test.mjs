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
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Details", "click Delete task", "wait This stops any running agent"])
    await page.getByRole("button", { name: /^Delete$/ }).click()
    await ui.run(["wait the task is being merged"])
    assert.ok(await page.getByRole("button", { name: /^Delete$/ }).isVisible(), "the dialog stays open")
    assert.equal((await server.rpc("tasks.get", { id: task.id })).title, "Stays put")
  })
})
