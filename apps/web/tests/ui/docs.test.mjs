// HA-281 (6.3): the profile's Docs page, in the sidebar: the documents its agents publish, each with its menu of pages
// and its versions. `--demo` seeds one ("Rollout plan", two versions, with an image). Changed from the old check: the
// assistant's entry isn't on this server yet (6.7), and the page's reads go over the RPC socket, so the old count of
// its HTTP requests for a version (one, for one page) isn't taken.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeTask, seedThread, startServer, withBrowser } from "./harness.mjs"
import { demoProfile, path, reader, waitPath } from "./docs.mjs"

let server, profile
beforeAll(async () => {
  server = startServer("--demo")
  profile = await demoProfile(server)
})
afterAll(() => server?.stop())

const DOC = "/docs/Default/d/rollout-plan"

test("the sidebar's Docs lists the profile's documents, and a document's links, menu and versions move between its pages", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/Default", "wait Try a scratch task"])
    // The board's page lets frames hold only its own pages: an agent's page in one can't navigate it elsewhere.
    assert.equal(await page.locator("meta[http-equiv=Content-Security-Policy]").getAttribute("content"), "frame-src 'self'")
    assert.equal(await page.locator("nav[aria-label=Docs]").count(), 1)
    await ui.run(["click css=nav[aria-label=Docs] >> text=Docs", "wait Rollout plan"])
    assert.equal(path(page), "/docs/Default")
    // In its project's folder.
    assert.equal(await page.locator("table[aria-label=Documents] tbody tr").count(), 2)
    const row = page.locator("table[aria-label=Documents] tbody tr", { hasText: "Rollout plan" })
    assert.equal(await row.count(), 1)
    assert.match(await row.innerText(), /Rollout plan\s+rollout-plan · 5 pages\s+plans\/releases\s+v2\s+just now\s+DEMO-5\s*Finished work to look over/)
    assert.match(await row.getByRole("link", { name: /Finished work to look over/ }).getAttribute("href"), /^\/t\//)
    assert.ok(await page.locator("nav[aria-label=Docs] button").evaluate((b) => b.className.includes("bg-raised")), "the entry is marked")

    // The latest version's index, in the reader's styles with the board's colours.
    await ui.run(["click Rollout plan"])
    await waitPath(page, DOC)
    const frame = reader(page)
    await frame.locator("h1", { hasText: "Rollout plan" }).waitFor()
    const look = await frame.locator(".docs-render").evaluate((el) => {
      const h2 = el.querySelector("h2")
      return { bg: getComputedStyle(el).backgroundColor, rule: getComputedStyle(h2).borderBottomStyle }
    })
    assert.deepEqual(look, { bg: "rgb(11, 11, 14)", rule: "solid" })
    // Its image (an AVIF the host keeps), given to the sandboxed frame as a data: URL: the frame can't fetch the host's
    // image itself, and its policy still refuses anything remote.
    const image = frame.locator("img[alt='Progress by phase']")
    const shown = await image.evaluate(async (el) => (await el.decode(), { src: el.getAttribute("src").slice(0, 23), width: el.naturalWidth }))
    assert.deepEqual(shown, { src: "data:image/avif;base64,", width: 480 })
    await ui.run(["wait Add phase 2 and the open questions"])
    assert.equal(await page.getByRole("combobox", { name: "Version" }).inputValue(), "2")
    // The merged version's menu reads in order (its pages' `order:`, as a merge keeps the others' positions).
    assert.deepEqual(await page.locator("nav[aria-label=Pages] button").allInnerTexts(), ["Rollout plan", "Phases", "Phase 1", "Phase 2", "Notes"])

    // A link to a heading in the page stays in the page (in a srcdoc frame it would load the board's address there).
    await frame.locator("h2 .anchor").click()
    await page.waitForTimeout(300)
    assert.equal(path(page), `${DOC}/`)
    assert.equal(await frame.locator(".docs-render h1").count(), 1)
    // A link out opens in a tab of its own.
    await page.context().route("https://github.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>docs</title>" }))
    const [tab] = await Promise.all([page.context().waitForEvent("page"), frame.getByRole("link", { name: "the docs app" }).click()])
    assert.equal(tab.url(), "https://github.com/dire-kiwi/docs")
    await tab.close()
    assert.equal(path(page), `${DOC}/`)

    // A link between pages opens the page here.
    await frame.getByRole("link", { name: "Phase 1" }).click()
    await waitPath(page, `${DOC}/plan/phase-1`)
    await frame.locator("h1", { hasText: "Phase 1" }).waitFor()
    assert.equal(await page.locator("nav[aria-label=Pages] [aria-current=page]").innerText(), "Phase 1")

    // The menu, nested: a folder's own page, then another page.
    await page.locator("nav[aria-label=Pages]").getByRole("button", { name: "Phases" }).click()
    await waitPath(page, `${DOC}/plan`)
    await frame.locator("h1", { hasText: "Phases" }).waitFor()
    await page.locator("nav[aria-label=Pages]").getByRole("button", { name: "Notes" }).click()
    await waitPath(page, `${DOC}/notes`)
    // Its form fields are read-only, and say why.
    await frame.getByText("Read-only: local documents don't collect answers.").first().waitFor()
    assert.equal(await frame.locator(".field input:not([disabled]), .field textarea:not([disabled])").count(), 0)
    assert.ok((await frame.locator(".field input").count()) > 0)
    assert.equal(await frame.locator(".callout-warning").count(), 1)

    // The first version has no notes page: it says so, and opens its own first page.
    await page.getByRole("combobox", { name: "Version" }).selectOption("1")
    await waitPath(page, `${DOC}/-/v/1/notes`)
    await ui.run(["wait Version 1 of this document has no page “notes”.", "click Open its first page"])
    await waitPath(page, `${DOC}/-/v/1`)
    await frame.locator("h1", { hasText: "Rollout plan" }).waitFor()
    await ui.run(["wait First draft of the rollout plan", "wait An older version: the latest is v2."])
    assert.deepEqual(await page.locator("nav[aria-label=Pages] button").allInnerTexts(), ["Rollout plan", "Phases", "Phase 1"])
    // Its links stay in that version.
    await frame.getByRole("link", { name: "Phase 1" }).click()
    await waitPath(page, `${DOC}/-/v/1/plan/phase-1`)
    await frame.locator("h1", { hasText: "Phase 1" }).waitFor()
    await ui.run(["click Read the latest"])
    await waitPath(page, `${DOC}/plan/phase-1`)
    await ui.run(["gone An older version"])

    // Back and forward go through the pages read.
    await page.goBack()
    await waitPath(page, `${DOC}/-/v/1/plan/phase-1`)
    await ui.run(["wait First draft of the rollout plan"])

    // A version that isn't there says so, and offers the latest.
    await ui.run([`goto ${DOC}/-/v/9/plan`, "wait Version 9 not found.", "click Read the latest"])
    await waitPath(page, `${DOC}/plan`)
    await reader(page).locator("h1", { hasText: "Phases" }).waitFor()
  })
})

// Agents' links name the profile by its id (`docBase` in apps/server/src/docs/docRules.ts).
test("an agent's link to a version's page opens it, with the profile's Docs marked", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /docs/${profile.id}/d/rollout-plan/-/v/2/plan/phase-2`, "wait Add phase 2 and the open questions"])
    await reader(page).locator("h1", { hasText: "Phase 2" }).waitFor()
    assert.ok(await page.locator("nav[aria-label=Docs] button").evaluate((b) => b.className.includes("bg-raised")))
    // The latest is v2 itself: no older version's note.
    assert.equal(await page.getByText("An older version").count(), 0)
    // Its link up a folder, to the document's first page.
    await reader(page).getByRole("link", { name: "Back to the plan" }).click()
    await waitPath(page, `/docs/${profile.id}/d/rollout-plan/-/v/2/`)
    await reader(page).locator("h1", { hasText: "Rollout plan" }).waitFor()
  })
})

// The `publish_document` result names the host's own address (127.0.0.1 unless it has a public URL): the thread links
// to the board's page instead.
test("a task's thread links to the document it published, on the board's Docs page", async () => {
  const [project] = await server.rpc("projects.list", { profile_id: profile.id })
  const task = await makeTask(server, project, { title: "Publishes a plan" })
  const url = `http://127.0.0.1:9/docs/${profile.id}/d/rollout-plan/`
  const result = JSON.stringify({ slug: "rollout-plan", version: 1, url, version_url: `${url}-/v/1/`, pages: [] })
  seedThread(server, task, [
    { id: "legacy:1", type: "user_message", text: "Write the plan up." },
    {
      id: "d1",
      type: "tool_call",
      name: "mcp__docs__publish_document",
      kind: "mcp",
      input: { title: "Rollout plan", pages: [] },
      status: "completed",
      result: { content: result },
    },
    { id: "legacy:3:0", type: "assistant_message", text: "Published it." },
  ])
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Published it."])
    // The version it published, not the latest.
    const link = page.getByRole("link", { name: "Open “Rollout plan” (v1) in Docs" })
    assert.equal(await link.getAttribute("href"), `/docs/${profile.id}/d/rollout-plan/-/v/1/`)
    await link.click()
    await waitPath(page, `/docs/${profile.id}/d/rollout-plan/-/v/1`)
    await reader(page).locator("h1", { hasText: "Rollout plan" }).waitFor()
    await ui.run(["wait First draft of the rollout plan"])
  })
})

test("a document deleted from the list leaves it, and the document's page open elsewhere says so", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto ${DOC}/`, "wait Add phase 2 and the open questions"])
    const list = await page.context().newPage()
    await list.goto(`${server.url}/docs/Default`)
    await list.getByRole("button", { name: "Delete Rollout plan" }).click()
    await list.getByText("Delete “Rollout plan”?").waitFor()
    await list.getByRole("button", { name: "Delete", exact: true }).click()
    await list.getByText("No documents yet.").waitFor()
    assert.deepEqual(await server.rpc("docs.list", { profile_id: profile.id }), [])
    // Told by the host's event.
    await ui.run(["wait has no document “rollout-plan”"])
  })
})
