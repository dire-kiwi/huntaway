// A done task, archived or not, moves back from its right-click menu (HA-156), and the menu, taller with the moves in
// it, scrolls on a short window: the old moveBackMenu check, on the demo board (`--demo`, which has a task done a week
// ago, so archived).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer("--demo")
  const [profile] = await server.rpc("profiles.list")
  project = (await server.rpc("projects.list", { profile_id: profile.id })).find((p) => p.name === "Demo")
})
afterAll(() => server?.stop())

const DONE = "Merged and closed"
const TODO = "Try dragging this card to another column"
const ARCHIVED = "Shipped last week"

/** Waits for the task called `title` to be in `status`, with no resolution. */
const movedTo = (title, status) =>
  eventually(async () => {
    const t = (await tasksByTitle(server, project))[title]
    assert.deepEqual([t.status, t.resolution], [status, null])
  })

// HA-156: a done task, archived or not, goes back to To do or Backlog from its right-click menu, not only by dragging.
test("a done task moves back to To do or Backlog from its right-click menu", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, `wait ${DONE}`, `rclick ${DONE}`, "wait [role=menu]"])
    // The statuses to move to, then Done's resolutions.
    const labels = await page.locator("[role=menu] [role^=menuitem]").allTextContents()
    for (const l of ["Backlog", "To do", "In progress", "Won't fix"])
      assert.ok(
        labels.some((t) => t.includes(l)),
        `${l} in ${labels}`,
      )
    await ui.run(["click [role=menu] >> text=Backlog", "gone [role=menu]"])
    await movedTo(DONE, "backlog")

    // An archived task, in the list view, goes back to To do.
    await ui.run([
      "click List view",
      "click css=#archived-tasks button",
      `wait ${ARCHIVED}`,
      `rclick ${ARCHIVED}`,
      "wait [role=menu]",
      "click [role=menu] >> text=To do",
    ])
    await movedTo(ARCHIVED, "todo")
  })
})

// The menu is taller with the moves in it: on a short desktop window it stays on screen and scrolls to its last item.
test("the right-click menu scrolls on a short desktop window", async () => {
  await withBrowser(server, { size: "1280x600" }, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}`, `wait ${TODO}`, `rclick ${TODO}`, "wait [role=menu]"])
    const box = await page.locator("[role=menu]").boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= 600, `the menu fits the window: ${JSON.stringify(box)}`)
    const last = page.locator("[role=menu] [role^=menuitem]").last()
    await last.scrollIntoViewIfNeeded()
    const r = await last.boundingBox()
    assert.ok(r.y >= box.y && r.y + r.height <= box.y + box.height + 1 && r.y + r.height <= 600, `the last item is reachable: ${JSON.stringify(r)}`)
    assert.match(await last.textContent(), /Set title/)
  })
})
