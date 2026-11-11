import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { column, DEMO_TASKS, eventually, seedBoard, startServer, tasksByTitle, withBrowser } from "./harness.mjs"

let server, board
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

// The web app on the new server (docs/plan/13-milestones.md, 1.6): the board shows a project's tasks in their columns,
// and New task's dialog makes a task in it, as the old board's did.
test("the board shows the project's tasks by column, and New task makes one", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}`, "wait Something being worked on"])
    await column(page, "In progress").getByText("Something being worked on").waitFor()
    await column(page, "Needs attention").getByText("A task waiting on an answer").waitFor()
    await column(page, "In review").getByText("Finished work to look over").waitFor()

    await ui.run(["click New task", "type Write the release notes", "press Control+Enter", "gone Reads as", "wait Write the release notes"])
    await column(page, "To do").getByText("Write the release notes").waitFor()
    const made = (await tasksByTitle(server, board.project))["Write the release notes"]
    assert.equal(made.status, "todo")
    assert.equal(made.key, `DEM-${made.number}`)
  })
})

// The home page goes to the board of the profile picked last (the only one here).
test("home opens the profile's board", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /", "wait Something being worked on"])
    await page.waitForURL((u) => u.pathname === "/profile/Default")
  })
})

// A browser without the board's token sees the token screen, and is on the board once it gives the token.
test("without a token the token screen asks for one, and the board shows once it's given", async () => {
  await withBrowser(server, { token: "" }, async (ui) => {
    await ui.run(["goto /", "wait Access token required", "click css=input[type=password]", `type ${server.token}`, "click Connect"])
    await ui.run(["wait Something being worked on", "gone Access token required"])
  })
})

// `?token=` signs in and comes off the URL (how the desktop shell and shared links sign in).
test("a ?token= in the URL signs in and is taken off it", async () => {
  await withBrowser(server, { token: "" }, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${board.project.id}?token=${server.token}`, "wait Something being worked on"])
    await eventually(() => assert.equal(new URL(page.url()).search, ""))
    assert.equal(await page.evaluate(() => localStorage.getItem("ia.token")), server.token)
  })
})
