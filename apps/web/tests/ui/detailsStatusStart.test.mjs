// Moving a fresh task to In progress starts its agent, from its details as from a drop on the board (HA-32, HA-262),
// from the old detailsStatusStart check. Agents run with the fake claude (packages/testing/bin/fake-claude), which logs
// each call to <data dir>/fake-claude.log and answers without a model.
//
// Both wait for Runs (plan task 2.5): until then the server answers the message that starts the agent with Unavailable.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { column, eventually, seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedAgentBoard(server)
})
afterAll(() => server?.stop())

const logged = (text) => {
  const log = `${server.dataDir}/fake-claude.log`
  return existsSync(log) && readFileSync(log, "utf8").includes(text)
}

// Waits for Runs (2.5). HA-32: moving a fresh task to In progress from its Details tab only changed its column, where a
// drop on the board starts its agent too. It checks the agent starts with the task, replies, and the task moves on.
test.skip("In progress from a task's Details starts its agent (waits for Runs, 2.5)", async () => {
  const task = await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Start me", description: "Say hello." } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, "click Details"])
    await page.locator("section:has(h3:text-is('Status')) button", { hasText: "In progress" }).click()
    await ui.run(["click Thread", "wait Fake reply to:"])
  })
  // The fake agent's run ends at once, which moves the task on to In review.
  await eventually(async () => assert.equal((await server.rpc("tasks.get", { id: task.id })).status, "in_review"))
  assert.ok(logged("Say hello."), "the agent was started with the task")
})

// Waits for Runs (2.5). HA-262: the board's drop and the phone's Move go through moveTask, as Details does. It checks a
// fresh task dropped into In progress starts its agent with the task.
test.skip("a fresh task dropped into In progress on the board starts its agent (waits for Runs, 2.5)", async () => {
  await server.rpc("tasks.create", { task: { project_id: board.project.id, title: "Drop me", description: "Say hi from the drop." } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Drop me"])
    await page.locator("[data-task]", { hasText: "Drop me" }).dragTo(column(page, "In progress"))
    await eventually(() => assert.ok(logged("Say hi from the drop."), "the agent was started with the task"))
  })
})
