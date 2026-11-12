// Picking tasks in the board's graph view (the old graphPicks check, HA-109, HA-285): tasks linked in the graph can be
// picked on their own or together and put in a pen, and the graph keeps to the status filter.
//
// Changed: the old check's tasks were a subproject's (`legacySubproject`), which the graph showed beside the
// subproject. Subprojects are gone (docs/plan/14-dropped-and-open.md: replaced by `merges_into`), so here the two tasks
// merge into a third ("Checkout rework"), which links them in the graph the way the subproject did. The old filter
// case leaned on a subproject's status following its tasks' (one done put it in review); a task's own status doesn't
// follow anything, so the task they merge into is put in review here.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, updateTask, withBrowser } from "./harness.mjs"

let server, board, sp, a, b
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
  sp = await makeTask(server, board.project, { title: "Checkout rework", status: "todo" })
  a = await makeTask(server, board.project, { title: "Child alpha", status: "todo", merges_into: sp.id })
  b = await makeTask(server, board.project, { title: "Child beta", status: "todo", merges_into: sp.id })
})
afterAll(() => server?.stop())

const byId = (x, y) => x.localeCompare(y)

// Which of the three tasks are in pen `name`.
const penIds = async (name) => {
  const pens = await server.rpc("pens.list", { profile_id: board.profile.id })
  const pen = pens.find((p) => p.name === name)
  const ids = []
  for (const t of [sp, a, b]) if (pen && (await server.rpc("tasks.get", { id: t.id })).pen_id === pen.id) ids.push(t.id)
  return ids.toSorted(byId)
}
const ctrlRightClick = async (page, id) => {
  await page.keyboard.down("Control")
  await page.click(`[data-task="${id}"]`, { button: "right" })
  await page.keyboard.up("Control")
}

// HA-109 review, HA-285: the graph's linked tasks can be picked on their own or with others, and put in a pen together.
test("the graph's linked tasks can be picked and put in a pen", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Checkout rework", "click Graph view", "wait Child alpha", "wait Child beta"])
    await ctrlRightClick(page, b.id)
    await ui.run(["wait 1 task picked"])
    await ctrlRightClick(page, a.id)
    await ctrlRightClick(page, sp.id)
    await ui.run(["wait 3 tasks picked"])
    await page.click("[data-selection-bar] >> text=Pen")
    await ui.run(["click New pen… (3 picked)", "type Checkout", "press Enter", "gone Create pen", "gone 3 tasks picked"])
    await eventually(async () => assert.deepEqual(await penIds("Checkout"), [sp.id, a.id, b.id].toSorted(byId)))
  })
})

// HA-109 review: the status filter holds for the graph's linked tasks too, whether or not what they link to shows.
test("the graph's linked tasks follow the status filter", async () => {
  await updateTask(server, a, { status: "done" })
  await updateTask(server, sp, { status: "in_review" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Checkout rework", "click Graph view", "wait Child alpha", "wait Child beta"])
    const only = (id) =>
      page.waitForFunction((want) => document.querySelectorAll("[data-task]").length === 1 && !!document.querySelector(`[data-task="${want}"]`), id)
    const toggle = (status) => ui.run(["click Filter", `click css=[role=menuitemcheckbox] >> text=${status}`, "press Escape"])
    // Done: the done task shows though the task it merges into (in review) doesn't, and the other, to do, is left out.
    await toggle("Done")
    await only(a.id)
    // In review instead: the task they merge into alone, as neither of the two is in review.
    await toggle("Done")
    await toggle("In review")
    await only(sp.id)
  })
})
