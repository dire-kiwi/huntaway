import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

// HA-25: the project settings are in tabs down the side. Changes on one tab are kept while another is open, the tabs
// with any are marked, and Save changes saves them all, from any tab. (Saved from Automations, as the old check did: a
// tab that saves as it goes, whose own content is 6.5's, so the check waits for its heading.)
test("unsaved changes are kept across the tabs and saved together", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) })
    const panel = page.getByRole("tabpanel")
    // An unknown tab is the first one.
    await ui.run([`goto /p/${project.id}/settings/nope`, "wait Danger zone"])
    assert.equal(await tab("General").getAttribute("aria-selected"), "true")

    await panel.getByLabel("Name").fill("Renamed")
    await tab("Worktrees").click()
    await page.waitForURL(/\/settings\/worktrees$/)
    await panel.getByLabel("Base branch").fill("trunk")
    await ui.run(["wait Unsaved changes in General, Worktrees"])
    assert.equal(await tab("General").getByLabel("Unsaved changes").count(), 1)
    assert.equal(await tab("Agents").getByLabel("Unsaved changes").count(), 0)

    await tab("General").click()
    assert.equal(await panel.getByLabel("Name").inputValue(), "Renamed")

    // Saved from a tab that saves as it goes.
    await tab("Automations").click()
    await ui.run(["wait css=h2:text-is('Automations')", "click Save changes", "gone Save changes"])
    const saved = await server.rpc("projects.get", { id: project.id })
    assert.equal(saved.name, "Renamed")
    assert.equal(saved.base_branch, "trunk")

    // A change put back as it was isn't one, and Discard drops the others.
    await page.reload()
    await ui.run(["wait css=h2:text-is('Automations')"])
    await tab("Worktrees").click()
    await panel.getByLabel("Base branch").fill("dev")
    await panel.getByLabel("Base branch").fill("trunk")
    await tab("General").click()
    await panel.getByLabel("Key").fill("RNM")
    await ui.run(["wait Unsaved changes in General"])
    assert.equal(await tab("Worktrees").getByLabel("Unsaved changes").count(), 0)
    await ui.run(["click Discard", "gone Unsaved changes"])
    assert.equal(await panel.getByLabel("Key").inputValue(), project.key)
  })
})

// HA-406: the board's own settings are in tabs down the side too, the open one in the URL. (The Hosts panel is M7's:
// the check waits for its tab rather than its Add host.)
test("the global settings are in tabs, the open one in the URL", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) })
    // An unknown tab is the first one.
    await ui.run(["goto /settings/nope", "wait role=tab[name=/^Hosts/]"])
    assert.equal(await tab("Hosts").getAttribute("aria-selected"), "true")
    assert.equal(await page.getByText("Keyboard shortcuts", { exact: true }).count(), 1, "only its tab, not its panel")

    await tab("Keyboard shortcuts").click()
    await page.waitForURL(/\/settings\/shortcuts$/)
    await ui.run(["wait css=h2:text-is('Keyboard shortcuts')"])
    await page.reload()
    await ui.run(["wait css=h2:text-is('Keyboard shortcuts')"])
    assert.equal(await tab("Keyboard shortcuts").getAttribute("aria-selected"), "true")
  })
})

// The old Settings: a tab whose panel would show nothing has none. On a server whose agents are off, its host keeps no
// agent configs and has no skills to set; a board with a profile has archived projects.
test("the settings show the tabs that have something to show", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(["goto /settings", "wait role=tab[name=/^Archived projects/]"])
    for (const hidden of ["Agent configs", "Skills and MCP"]) assert.equal(await ui.page.getByRole("tab", { name: hidden }).count(), 0, hidden)
    assert.equal(await ui.page.getByRole("tab", { name: "Assistant" }).count(), 1)
  })
})
