import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

// HA-142: each reviewer can have instructions and skills of its own, which the settings keep through other edits to it.
// (The board's skills offered to pick from are the agent tools', 6.4: the old check made one first; this one types the
// names.)
test("a reviewer's own instructions and skills are saved, and kept when its other settings change", async () => {
  /** The project's reviewers once `until` is true of them. */
  const saved = (until) =>
    eventually(async () => {
      const { reviewers } = await server.rpc("projects.get", { id: project.id })
      assert.ok(until(reviewers))
      return reviewers
    })
  await server.rpc("projects.update", {
    id: project.id,
    patch: {
      reviewers: [
        { claude_config_id: null, model: null, effort: null },
        { claude_config_id: null, model: "haiku", effort: null },
      ],
    },
  })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}/settings/review`, "wait Reviewers"])
    const toggles = page.getByRole("button", { name: "Instructions and skills" })
    // They show once the default instructions have loaded.
    await toggles.first().waitFor()
    assert.equal(await toggles.count(), 2)
    await toggles.nth(1).click()
    // Its instructions start as the default ones, which aren't saved as its own.
    const prompt = page.getByRole("textbox", { name: "What it looks for" })
    assert.match(await prompt.inputValue(), /^Look for correctness problems/)
    await prompt.fill("Only look for security holes.")
    await page.getByLabel("Skills it uses", { exact: true }).fill("audit, /security-review")
    // Changing its effort (or config or model) keeps them.
    await page.locator("select[title='Effort']").nth(1).selectOption({ index: 1 })
    await ui.run(["click Save changes"])
    let reviewers = await saved((r) => r[1].prompt)
    assert.equal(reviewers.length, 2)
    assert.equal(reviewers[0].prompt, undefined)
    assert.equal(reviewers[1].prompt, "Only look for security holes.")
    assert.deepEqual(reviewers[1].skills, ["audit", "security-review"])
    assert.equal(reviewers[1].model, "haiku")

    // After a reload they're there, and Reset to default takes the instructions off.
    await page.reload()
    await ui.run(["wait Reviewers"])
    await toggles.first().waitFor()
    await toggles.nth(1).click()
    assert.equal(await page.getByRole("textbox", { name: "What it looks for" }).inputValue(), "Only look for security holes.")
    assert.equal(await page.getByLabel("Skills it uses", { exact: true }).inputValue(), "audit, security-review")
    await ui.run(["click Reset to default", "click Save changes"])
    reviewers = await saved((r) => !r[1].prompt)
    assert.equal(reviewers[1].prompt, undefined)
    assert.deepEqual(reviewers[1].skills, ["audit", "security-review"])
  })
})
