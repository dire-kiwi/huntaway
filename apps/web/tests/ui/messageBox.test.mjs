// What a task's message box gets from its host: the boards `@` offers (HA-303), from the old messageBox check.
//
// Dropped from the old check: "the / menu lists a skill saved in the project, and picks it" and "$ lists a Codex task's
// skills": the host's skills list comes with 6.4 (the composer's skill menu is inert until then), and Codex with M5.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProject, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, board, notes
beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
  const other = async (name, access, key, title) => {
    const profile = await server.rpc("profiles.create", { profile: { name, agent_access: access } })
    const project = await makeProject(server, profile, `${name} project`, key)
    await makeTask(server, project, { title, status: "todo" })
  }
  // work lets Default's agents in; secret doesn't.
  await other("work", ["Default"], "WRK", "Deploy previews")
  await other("secret", [], "SEC", "Deploy secrets")
  notes = await makeTask(server, board.project, { title: "Release notes", status: "in_review" })
})
afterAll(() => server?.stop())

const listed = (page) => page.locator("role=listbox[name='Projects and tasks'] >> role=option").allInnerTexts()

// HA-303: `@` lists projects and tasks on the profile's own board and those that let its agents in, and picking one puts
// its key in (qualified with its profile when it's another's).
test("@ in the message box offers the boards that let the profile's agents in, and picks a key", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const value = () => page.locator("textarea").inputValue()
    await ui.run([`goto /t/${notes.id}`, "click thread", "click css=textarea", "type See @deplo", "wait role=option[name=/Deploy previews/]"])
    const options = await listed(page)
    assert.ok(!options.some((o) => o.includes("secrets")), `secret's board isn't offered: ${options}`)
    await ui.run(["press Enter"])
    assert.equal(await value(), "See work:WRK-1 ")
    await ui.run(["type and @release", "wait role=option[name=/Release notes/]", "press Tab"])
    assert.equal(await value(), `See work:WRK-1 and ${board.project.key}-${notes.number} `)
  })
})
