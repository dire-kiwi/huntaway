import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

// IA-121: an archived project goes off the board (sidebar and its profile's board, after a reload too). Unarchiving it
// in Settings → Archived projects, the old check's second half, comes with settings/.
test("archives a project from the sidebar", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const row = "css=aside >> role=button[name=/^DEM Demo/]"
    const task = "Something being worked on"
    await ui.run([`goto /p/${board.project.id}`, `wait ${row}`, `rclick ${row}`, "click [role=menu] >> text=Archive…", "wait Archive Demo"])
    await ui.run(["click [data-modal] >> role=button[name='Archive project']", "gone Archive Demo", `gone ${row}`])
    await page.waitForURL(/\/profile\/Default$/)
    await ui.run(["wait No projects"])
    assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(task), "its tasks are off the profile's board")

    await ui.run([`goto /p/${board.project.id}`, "wait Demo is archived"])
    assert.doesNotMatch(await page.locator("aside").innerText(), /Demo/, "still archived after a reload")
    const listed = await server.rpc("projects.list", { profile_id: board.profile.id })
    assert.equal(
      listed.some((p) => p.id === board.project.id),
      false,
    )
  })
})
