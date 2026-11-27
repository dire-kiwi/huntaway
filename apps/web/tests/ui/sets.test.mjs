// Sets of tasks across repositories in the web (HE-120): the New task dialog's "Also in", "1 of N" on each set task's
// card with the lead marked, and the "Set" section in Details.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProfile, makeProject, startServer, withBrowser } from "./harness.mjs"

let server, shop, api, web
beforeAll(async () => {
  server = startServer()
  const profile = await makeProfile(server)
  shop = await makeProject(server, profile, "Shop", "SHOP")
  api = await makeProject(server, profile, "Api", "API")
  web = await makeProject(server, profile, "Web", "WEB")
  // Another profile's project isn't offered.
  await makeProject(server, await makeProfile(server, "Work"), "Elsewhere", "ELSE")
})
afterAll(() => server?.stop())

const tasksIn = (project) => server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })
const alsoIn = (page) => page.getByRole("group", { name: "Also in" })

test("Also in makes a set: its cards say 1 of 3, the lead marked, and Details lists the set", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([`goto /p/${shop.id}`, "click New task", "wait Reads as", "type Add a status endpoint and show it."])
    await page.getByRole("switch", { name: "Also in other projects" }).click()
    // The profile's other projects, not its own or another profile's.
    assert.deepEqual(await alsoIn(page).getByRole("button").allInnerTexts(), ["API\nApi", "WEB\nWeb"])
    // A `from:` clears what's picked and hides the picker; taking it out doesn't bring them back.
    await alsoIn(page).getByRole("button", { name: /Api/ }).click()
    const description = page.getByRole("textbox", { name: "Description" })
    await description.fill("Add a status endpoint and show it. from:main ")
    await alsoIn(page).waitFor({ state: "detached" })
    await page.getByRole("switch", { name: "Also in other projects" }).waitFor({ state: "detached" })
    await description.fill("Add a status endpoint and show it.")
    await alsoIn(page).waitFor()
    assert.deepEqual(await alsoIn(page).locator("[aria-pressed=true]").count(), 0)
    // Picked, it needs a title to be created.
    await alsoIn(page).getByRole("button", { name: /Api/ }).click()
    await alsoIn(page).getByRole("button", { name: /Web/ }).click()
    const create = page.getByRole("button", { name: /^Create task/ })
    assert.equal(await create.isDisabled(), true)
    await page.getByRole("textbox", { name: "Set title" }).fill("Status endpoint")
    await create.click()
    await ui.run(["gone Reads as", "wait Status endpoint"])
  })

  const [lead] = await tasksIn(shop)
  const [apiTask] = await tasksIn(api)
  const [webTask] = await tasksIn(web)
  assert.equal(lead.title, "Status endpoint")
  assert.equal(lead.lead_id, null)
  assert.equal(apiTask.lead_id, lead.id)
  assert.equal(webTask.lead_id, lead.id)

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const card = (t) => page.locator(`[data-task="${t.id}"]`)
    // The lead's card: 1 of 3, with a crown that says it leads.
    await ui.run([`goto /p/${shop.id}`, "wait Status endpoint"])
    const badge = card(lead).locator("[data-set]")
    assert.equal(await badge.getAttribute("data-set"), "1 of 3")
    assert.match(await badge.getAttribute("title"), /^The lead of a set .*: SHOP-1 \(Shop\), the lead, API-1 \(Api\), WEB-1 \(Web\)$/)
    // Each other's card: its place.
    await ui.run([`goto /p/${web.id}`, "wait Status endpoint"])
    assert.equal(await card(webTask).locator("[data-set]").getAttribute("data-set"), "3 of 3")
    assert.match(await card(webTask).locator("[data-set]").getAttribute("title"), /^In a set /)

    // Details lists the set, each with its project and status, and opens each one.
    await ui.run([`goto /p/${web.id}?task=${webTask.id}`, "click Details", "wait 3 repositories"])
    const rows = page.locator("[data-set-task]")
    assert.deepEqual(
      (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()),
      ["SHOP-1 Shop lead To do", "API-1 Api To do", "WEB-1 Web To do"],
    )
    assert.equal(await page.locator("[data-set-task='WEB-1']").getAttribute("aria-current"), "true")
    await page.locator("[data-set-task='API-1']").click()
    await page.waitForURL((u) => u.searchParams.get("task") === apiTask.id)
    await page.locator("[data-set-task='API-1'][aria-current=true]").waitFor()
  })
})

test("Also in isn't offered for a scratch task, or without a worktree", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const toggle = page.getByRole("switch", { name: "Also in other projects" })
    await ui.run([`goto /p/${shop.id}`, "click New task", "wait Reads as", "type A thing to try"])
    await toggle.waitFor()
    await page.getByRole("switch", { name: "Own git worktree" }).click()
    await toggle.waitFor({ state: "detached" })
    await page.getByRole("switch", { name: "Own git worktree" }).click()
    await toggle.waitFor()
    await page.getByRole("textbox", { name: "Description" }).fill("/scratch A thing to try")
    await toggle.waitFor({ state: "detached" })
  })
})
