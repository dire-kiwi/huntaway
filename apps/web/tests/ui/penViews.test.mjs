// The profile board's Active and Inactive views, a row for each pen (HA-292): the old penViews check, on a board seeded
// as the old demo board was, its pens made and filled over RPC where the old one used the REST API.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, eventually, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

const DRAG = "Try dragging this card to another column"
const WAITING = "A task waiting on an answer"
const REVIEW = "Finished work to look over"
const IDEA = "An idea for later"
const EDIT = "Edit this task's title and description"
const tab = (name) => `role=tab[name=/^${name}/]`
const lane = (name) => `[data-pen-lane="${name}"]`
const row = (name) => `section[aria-label="The ${name} pen"]`

const tasks = () => tasksByTitle(server, board.project)

// HA-292: under All, the Active and Inactive views show the tasks in active or inactive pens (not those in no pen), in a
// row for each pen in the pens' order. A task dropped in a row's column goes in that column and that pen, and a row
// collapsed to its header stays so over a reload.
test("the Active and Inactive views show a row for each pen", async () => {
  const ts = await tasks()
  const pen = (name) => server.rpc("pens.create", { pen: { profile_id: board.profile.id, name } })
  const today = await pen("Today")
  const billing = await pen("Billing")
  const parked = await pen("Parked")
  await server.rpc("pens.update", { id: parked.id, patch: { active: false } })
  const into = (title, p) => server.rpc("tasks.update", { id: ts[title].id, patch: { pen_id: p.id } })
  await into(DRAG, today)
  await into(WAITING, billing)
  await into(REVIEW, billing)
  await into(IDEA, parked)

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const lanes = () => page.locator("[data-pen-lane]").evaluateAll((es) => es.map((e) => e.dataset.penLane))
    const cardsIn = (name) => page.locator(`${row(name)} [data-task]`).evaluateAll((es) => es.map((e) => e.textContent))
    await ui.run(["goto /profile/Default", `click ${tab("Active")}`, `wait ${lane("Today")}`, `wait ${DRAG}`, `gone ${EDIT}`])
    assert.match(await page.locator(tab("Active")).textContent(), /^Active\s*3$/)
    assert.match(await page.locator(tab("Inactive")).textContent(), /^Inactive\s*1$/)
    assert.deepEqual(await lanes(), ["Today", "Billing"])
    assert.match(await page.locator(lane("Billing")).textContent(), /Billing\s*2/)
    assert.equal((await cardsIn("Today")).length, 1)
    assert.equal((await cardsIn("Billing")).length, 2)
    // No pen labels over the cards: the rows say which pen they're in.
    assert.equal(await page.locator("[data-pen-label]").count(), 0)

    // Dropped in Today's In review, a Billing task goes in Today, in review.
    await page.evaluate(
      ([title, target]) => {
        const card = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(title))
        const cell = document.querySelector(target)
        const dataTransfer = new DataTransfer()
        dataTransfer.setData("text/task-id", card.dataset.task)
        for (const type of ["dragover", "drop"]) cell.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
      },
      [WAITING, `${row("Today")} [data-status=in_review]`],
    )
    await eventually(async () => {
      const t = (await tasks())[WAITING]
      assert.deepEqual([t.pen_id, t.status], [today.id, "in_review"])
    })
    await eventually(async () => assert.equal((await cardsIn("Today")).length, 2))

    // Made from a row's +, a task goes in its pen.
    await ui.run(["click New task in the Billing pen", "type Made in the Billing row", "press Control+Enter", "gone Create task"])
    await eventually(async () =>
      assert.ok(Object.values(await tasks()).some((t) => t.description?.includes("Made in the Billing row") && t.pen_id === billing.id)),
    )
    await eventually(async () => assert.equal((await cardsIn("Billing")).length, 2))

    // Collapsed to its header, Today's row keeps its count, and stays collapsed over a reload.
    await ui.run([`click ${lane("Today")} >> role=button[expanded=true]`, `gone ${DRAG}`, `wait ${REVIEW}`])
    assert.match(await page.locator(lane("Today")).textContent(), /Today\s*2/)
    await ui.run(["goto /profile/Default", `wait ${lane("Today")}`, `wait ${REVIEW}`, `gone ${DRAG}`])
    assert.equal(await page.locator(`${lane("Today")} [aria-expanded]`).getAttribute("aria-expanded"), "false")
    // The list view has the rows too, collapsed the same.
    await ui.run([
      "click List view",
      `wait ${lane("Billing")}`,
      `wait ${REVIEW}`,
      `gone ${DRAG}`,
      `click ${lane("Today")} >> role=button[expanded=false]`,
      `wait ${DRAG}`,
    ])
    await ui.run(["click Board view", `wait ${lane("Today")}`, `wait ${DRAG}`])

    // The Inactive view: Parked's row, with its task in the backlog.
    await ui.run([`click ${tab("Inactive")}`, `wait ${lane("Parked")}`, `gone ${lane("Today")}`])
    assert.deepEqual(await lanes(), ["Parked"])
    assert.match(await page.locator(lane("Parked")).textContent(), /Parked\s*1/)

    // All keeps every task, those in no pen too.
    await ui.run([`click ${tab("All")}`, `wait ${EDIT}`, `wait ${DRAG}`, `gone ${lane("Today")}`])
  })
})
