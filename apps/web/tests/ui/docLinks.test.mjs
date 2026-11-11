import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, startServer, withBrowser } from "./harness.mjs"
import { demoProfile } from "./docs.mjs"

let server, project
beforeAll(async () => {
  server = startServer("--demo")
  ;[project] = await server.rpc("projects.list", { profile_id: (await demoProfile(server)).id })
})
afterAll(() => server?.stop())

// HA-321 (6.3): the link an agent gives to a document it published is the host's own address, shown as a URL and opened in a
// new window (the browser, in the desktop app). It shows the document's title, opens in the board, and the document's
// page links back to where it was opened from.
test("a link to a document shows its title, opens in the board, and has a link back", async () => {
  const url = "http://127.0.0.1:1/docs/Default/d/rollout-plan/"
  const task = await makeTask(server, project, {
    title: "Has doc links",
    description: `Published ${url}\n\nAnd [the same plan](${url}-/v/1/) and https://example.invalid/docs/Default/d/rollout-plan/ too.`,
  })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const board = `/p/${project.id}?task=${task.id}`
    await ui.run([`goto ${board}`, "click details", "wait Published"])
    const links = page.locator(".prose-chat a")
    // The URL is the title, the author's own words stay, and another site's link is as it was.
    await links.filter({ hasText: "Rollout plan" }).waitFor()
    assert.equal(await links.filter({ hasText: "127.0.0.1" }).count(), 0)
    assert.equal(await links.filter({ hasText: "the same plan" }).count(), 1)
    assert.equal(await links.filter({ hasText: "example.invalid" }).getAttribute("target"), "_blank")
    assert.equal(await links.filter({ hasText: "Rollout plan" }).getAttribute("target"), null)

    // It opens here, not in a window of its own.
    const popups = []
    page.on("popup", (p) => popups.push(p))
    await links.filter({ hasText: "Rollout plan" }).click()
    await page.waitForFunction(() => location.pathname === "/docs/Default/d/rollout-plan/")
    assert.deepEqual(popups, [])
    const back = page.getByRole("link", { name: /Back to Has doc links/ })
    await back.waitFor()
    // Moving about in the document keeps the way back.
    await ui.run(["wait Phases", "click Phases"])
    await back.waitFor()
    await back.click()
    await page.waitForFunction((want) => location.pathname + location.search === want, board)
    await page.locator(".prose-chat").first().waitFor()

    // Opened from the page itself, there's nothing to go back to.
    await ui.run(["goto /docs/Default/d/rollout-plan/", "wait Rollout plan"])
    assert.equal(await page.getByRole("link", { name: /Back to/ }).count(), 0)
  })
})
