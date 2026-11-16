import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, startServer, withBrowser } from "./harness.mjs"

let server, profile, project
beforeAll(async () => {
  server = startServer("--demo")
  profile = (await server.rpc("profiles.list")).find((p) => p.name === "Default")
  ;[project] = await server.rpc("projects.list", { profile_id: profile.id })
})
afterAll(() => server?.stop())

// HA-321 (6.3): the link an agent gives to a document it published is the host's own address, shown as a URL and opened
// in a new window (the browser, in the desktop app). It shows the document's slug and opens in the board, as the docs
// plugin's page (HE-42).
test("a link to a document shows its slug and opens in the board as the docs plugin's page", async () => {
  // As agents are given it, with the profile's id.
  const url = `http://127.0.0.1:1/docs/${profile.id}/d/rollout-plan/`
  const task = await makeTask(server, project, {
    title: "Has doc links",
    description: `Published ${url}\n\nAnd [the same plan](${url}-/v/1/) and https://example.invalid/docs/Default/d/rollout-plan/ too.`,
  })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait Published"])
    const links = page.locator(".prose-chat a")
    // The URL is the slug, the author's own words stay, and another site's link is as it was.
    await links.filter({ hasText: /^rollout-plan$/ }).waitFor()
    assert.equal(await links.filter({ hasText: "127.0.0.1" }).count(), 0)
    assert.equal(await links.filter({ hasText: "the same plan" }).count(), 1)
    assert.equal(await links.filter({ hasText: "example.invalid" }).getAttribute("target"), "_blank")
    assert.equal(await links.filter({ hasText: /^rollout-plan$/ }).getAttribute("target"), null)

    // It opens here, not in a window of its own, as the docs plugin's page.
    const popups = []
    page.on("popup", (p) => popups.push(p))
    await links.filter({ hasText: /^rollout-plan$/ }).click()
    await page.waitForFunction((want) => location.pathname === want, `/docs/${profile.id}/d/rollout-plan/`)
    assert.deepEqual(popups, [])
    // The docs plugin answers for it (the demo board has no documents).
    await page.getByText(`no document "rollout-plan"`).waitFor()
  })
})
