// A card's pen label, in its pen's colour, that opens the pen's tab (HA-294): the old penLabels check, on a board seeded
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
const EDIT = "Edit this task's title and description"
const tab = (name) => `role=tab[name=/^${name}/]`
const label = (name) => `[data-pen-label="${name}"]`

// HA-294: a card whose task is in a pen has a label over it with the pen's name in the pen's colour, on project boards
// and the profile board's All tab, but not on the pen's own tab. Each pen gets a colour of its own, which its tab's menu
// changes, and clicking a label opens the pen's tab.
test("cards in pens have their pen's label, in its colour", async () => {
  const { project, profile } = board
  const ts = await tasksByTitle(server, project)
  const today = await server.rpc("pens.create", { pen: { profile_id: profile.id, name: "Today" } })
  const billing = await server.rpc("pens.create", { pen: { profile_id: profile.id, name: "Billing" } })
  assert.notEqual(today.color, billing.color)
  await server.rpc("tasks.update", { id: ts[DRAG].id, patch: { pen_id: today.id } })
  await server.rpc("tasks.update", { id: ts[WAITING].id, patch: { pen_id: billing.id } })

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const colorOf = (name) => page.locator(label(name)).evaluate((e) => getComputedStyle(e).color)
    // On the project's board: each pen's label over its cards, and none over a card in no pen.
    await ui.run([`goto /p/${project.id}`, `wait ${label("Today")}`, `wait ${label("Billing")}`, `wait ${EDIT}`])
    assert.equal(await page.locator("[data-pen-label]").count(), 2)
    const card = (title) => page.locator("[data-task]", { hasText: title })
    const above = await page.evaluate(
      ([l, title]) => {
        const lab = document.querySelector(l).getBoundingClientRect()
        const c = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(title)).getBoundingClientRect()
        return { gap: c.top - lab.bottom, height: lab.height }
      },
      [label("Today"), DRAG],
    )
    assert.ok(above.gap >= 0 && above.gap < 2, `the label sits on its card (${JSON.stringify(above)})`)
    assert.ok(above.height <= 18, `the label is compact (${above.height}px)`)
    assert.equal(await card(EDIT).count(), 1)
    assert.notEqual(await colorOf("Today"), await colorOf("Billing"))
    const blue = await colorOf("Today")

    // The tab's menu changes its colour, which its labels take.
    await ui.run(["goto /profile/Default", `wait ${tab("Today")}`, `wait ${label("Today")}`])
    await ui.run([`click ${tab("All")}`, `rclick ${tab("Today")}`, "click [role=menu] >> text=Colour…", "click [role=menu] >> text=Teal", "gone [role=menu]"])
    await eventually(async () => assert.equal((await server.rpc("pens.list", { profile_id: profile.id })).find((p) => p.id === today.id).color, "teal"))
    await eventually(async () => assert.notEqual(await colorOf("Today"), blue))

    // Inside the pen's own tab its cards have no label.
    await ui.run([`click ${tab("Today")}`, `wait ${DRAG}`, `gone ${WAITING}`])
    assert.equal(await page.locator("[data-pen-label]").count(), 0)

    // A label on a project's board opens the pen's tab on the profile's board.
    await ui.run([`goto /p/${project.id}`, `click ${label("Billing")}`, `wait ${tab("Billing")}`, `wait ${WAITING}`, `gone ${DRAG}`])
    assert.equal(new URL(page.url()).pathname, "/profile/Default")
    assert.match(await page.locator("[role=tab][aria-selected=true]").textContent(), /^Billing/)
    // And on the profile's All tab, it switches to the tab there.
    await ui.run([`click ${tab("All")}`, `click ${label("Today")}`, `gone ${WAITING}`, `wait ${DRAG}`])
    assert.match(await page.locator("[role=tab][aria-selected=true]").textContent(), /^Today/)
  })
})
