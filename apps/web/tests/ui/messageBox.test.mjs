// What a task's message box gets from its host: the boards `@` offers (HA-303) and the skills `/` and `$` list (IA-146,
// 6.4), from the old messageBox check.
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

// IA-146: typing `/` lists the agent's skills, as the host finds them.
test("the / menu lists a skill saved in the project, and picks it", async () => {
  const content = "---\nname: release-notes\ndescription: Write the release notes.\n---\n\nWrite them.\n"
  await server.rpc("agentTools.addSkill", { project_id: board.project.id, skill: { content } })
  const task = await makeTask(server, board.project, { title: "Notes", status: "in_review" })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type /rel", "wait Write the release notes.", "press Enter"])
    assert.equal(await ui.page.locator("textarea").inputValue(), "/release-notes ")
  })
})

// IA-146 review: `$` is Codex's: the host says which agent a task's config is. The test server can't run Codex, so the
// task's skills are the board's.
test("$ lists a Codex task's skills", async () => {
  const codex = await server.rpc("configs.create", { config: { name: "Codex", config_dir: "", agent: "codex" } })
  await server.rpc("profiles.update", { id: board.profile.id, patch: { claude_config_ids: [codex.id] } })
  const task = await makeTask(server, board.project, { title: "Codex notes", status: "in_review", claude_config_id: codex.id })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type $rel", "wait $release-notes", "press Enter"])
    assert.equal(await ui.page.locator("textarea").inputValue(), "$release-notes ")
  })
})
