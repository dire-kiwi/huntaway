import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

// HE-32: what a setting does is behind the ? beside its label, not in a line under it.
test("a setting's help shows from its ?, and its label still focuses the field", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const help = page.getByRole("tooltip")
    await ui.run([`goto /p/${project.id}/settings/worktrees`, "wait Setup script"])
    assert.equal(await help.count(), 0)
    // The pointer on it shows it, and off it hides it.
    await ui.run(["hover Help: Folders to link", "wait role=tooltip >> text=Git-ignored folders", "hover text=New worktrees", "gone role=tooltip"])
    // A click keeps it open with the pointer elsewhere, until Escape, a second click or a press outside.
    await ui.run(["click Help: Setup script", "hover text=New worktrees", "wait role=tooltip >> text=Runs with bash", "press Escape", "gone role=tooltip"])
    await ui.run(["click Help: Setup script", "wait role=tooltip", "click Help: Setup script", "gone role=tooltip"])
    await ui.run(["click Help: Base branch", "wait role=tooltip", "click text=Worktrees folder", "gone role=tooltip"])
    // It's within the window, though its ? is by the right edge.
    await ui.run(["size 700x800", "click Help: Folders to link", "wait role=tooltip"])
    const box = await help.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 700, `the help is cut off: ${box.x} to ${box.x + box.width}`)
    await ui.run(["press Escape", "click text=Base branch"])
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "current HEAD")
  })
})

// The pull request and merge settings are a tab of their own, saved with the rest.
test("the Pull requests tab saves its settings", async () => {
  await server.rpc("projects.update", { id: project.id, patch: { pull_requests: true, done_when_merged: false } })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/pull-requests`,
      "wait Merging",
      "click role=switch[name='Open a pull request for each task']",
      "click role=switch[name='Move a task to Done when its pull request is merged on GitHub']",
      "wait Unsaved changes in Pull requests",
      "click Save changes",
      "wait Saved",
    ])
    await eventually(async () => {
      const p = await server.rpc("projects.get", { id: project.id })
      assert.deepEqual([p.pull_requests, p.done_when_merged], [false, true])
    })
  })
})
