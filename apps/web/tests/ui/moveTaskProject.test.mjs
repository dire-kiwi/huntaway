// HE-110: moving a task to another project makes a new task there with its title, prompt and labels, and asks whether
// to delete the original.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProject, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board, other
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
  other = await makeProject(server, board.profile, "Shop", "SHOP")
})
afterAll(() => server?.stop())

const newTask = (task) => server.rpc("tasks.create", { task: { project_id: board.project.id, ...task } })
const tasksIn = (project) => server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })

test("Move to project… in a card's menu, deleting the original", async () => {
  const task = await newTask({ title: "Moved from the menu", description: "The prompt that goes along.", labels: ["plan"], status: "backlog" })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${board.project.id}`,
      "click Backlog",
      "rclick Moved from the menu",
      "click [role=menu] >> text=Move to project…",
      "wait [role=dialog] >> text=Shop",
      "click [role=dialog] >> text=Delete original",
      "gone [role=dialog]",
      "wait The prompt that goes along.",
    ])
  })
  const moved = await eventually(async () => {
    const found = (await tasksIn(other)).find((t) => t.title === "Moved from the menu")
    assert.ok(found)
    return found
  })
  assert.equal(moved.description, "The prompt that goes along.")
  assert.equal(moved.status, "backlog")
  assert.deepEqual(moved.labels, ["plan"])
  await eventually(async () => assert.ok(!(await tasksIn(board.project)).some((t) => t.id === task.id)))
})

test("Move to project… in the details, keeping the original", async () => {
  const task = await newTask({ title: "Copied from the details", description: "Kept in both." })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${board.project.id}?task=${task.id}`,
      "click Details",
      "click Move to project…",
      "click [role=dialog] >> text=Keep original",
      "gone [role=dialog]",
    ])
  })
  const copy = await eventually(async () => {
    const found = (await tasksIn(other)).find((t) => t.title === "Copied from the details")
    assert.ok(found)
    return found
  })
  assert.equal(copy.description, "Kept in both.")
  assert.equal(copy.status, "todo")
  assert.equal((await server.rpc("tasks.get", { id: task.id })).title, "Copied from the details")
})
