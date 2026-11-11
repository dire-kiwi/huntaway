import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

// The board's own approvals, answered from their cards in the asking thread (plan task 3.4): the fake `claude` calls a
// board tool for each "fake-board-call <tool> <JSON>" line of its prompt, waits for its answer, and says in its reply
// what it returned ("board delete_task: {...}"). The old suite had no browser check of these cards; this one checks a
// deletion's and a project change's detail and answers.

let server, board
beforeAll(async () => {
  server = startServer("--fake-claude")
  board = await seedBoard(server)
})
afterAll(() => server?.stop())

/** A task whose agent was asked `text`. */
async function asking(title, text) {
  const task = await makeTask(server, board.project, { title })
  await server.rpc("tasks.send", { id: task.id, text })
  return task
}

test("a deletion shows what goes, and is made once confirmed", async () => {
  const doomed = await makeTask(server, board.project, { title: "Doomed" })
  const task = await asking("Asks to delete", `fake-board-call delete_task ${JSON.stringify({ task_id: doomed.key, reason: "A duplicate" })}`)
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${board.project.id}?task=${task.id}`, `wait Delete the task ${doomed.key} Doomed`, "wait A duplicate"])
    await ui.run(["wait This stops any running agent", 'click role=button[name="Delete"s]', "wait confirmed"])
    await ui.run(['wait text=/board delete_task: .*"deleted": true/'])
  })
  await eventually(async () => {
    const tasks = await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: board.project.id } })
    assert.equal(
      tasks.find((t) => t.id === doomed.id),
      undefined,
    )
  })
})

test("a project change shows each setting; denied, nothing changes", async () => {
  const change = { setup_script: "npm ci", model: "opus", reason: "Faster setup" }
  const task = await asking("Asks to change", `fake-board-call update_project ${JSON.stringify(change)}`)
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "wait Change the project Demo",
      "wait Faster setup",
      "wait Setup script",
      "wait needs approval",
    ])
    await ui.run(['click role=button[name="Deny"s]', "wait denied", "wait text=/didn't approve changing setup_script/"])
  })
  const project = await server.rpc("projects.get", { id: board.project.id })
  assert.deepEqual([project.setup_script, project.model], ["", null])
})
