// HA-290 (6.3): the Docs page shows a profile's documents as a tree of their folders (the demo's "Rollout plan" is filed
// under its project, Demo), which close and open as they were left; a document moves to another folder (a new one
// included) from its row's Move button or by dragging it onto a folder, and a folder's Rename moves everything in it.
// HA-324: the second test, its Labels view, a tree of their labels instead.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { startServer, withBrowser } from "./harness.mjs"
import { demoProfile, seedDocs } from "./docs.mjs"

let server, profile
beforeAll(async () => {
  server = startServer("--demo")
  profile = await demoProfile(server)
  // Two more documents, as agents would have published them (the board has no way to publish one itself).
  seedDocs(server, profile, [
    ["plan-b", "Plan B", "Demo/plans"],
    ["loose", "A loose report", ""],
  ])
})
afterAll(() => server?.stop())

/** The tree's rows as they read: a folder's name and count, or a document's title, indented by their depth. */
const tree = (page) =>
  page.locator("table[aria-label=Documents] tbody tr").evaluateAll((rows) =>
    rows.map((r) => {
      const folder = r.querySelector("button[aria-expanded]")
      const at = folder ?? r.querySelector("td > div")
      const depth = Math.round(parseFloat(at.style.paddingLeft || "0") / 18)
      const text = folder
        ? `${folder.getAttribute("aria-expanded") === "true" ? "v" : ">"} ${folder.innerText.replace(/\s+/g, " ")}`
        : r.querySelector("a").innerText
      return `${"  ".repeat(depth)}${text}`
    }),
  )

const folders = async () => Object.fromEntries((await server.rpc("docs.list", { profile_id: profile.id })).map((d) => [d.slug, d.folder]))

/** Waits for the tree to read `want`. */
async function waitTree(page, want) {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(await tree(page)) === JSON.stringify(want)) return
    await page.waitForTimeout(100)
  }
  assert.deepEqual(await tree(page), want)
}

test("documents are a tree of folders that stay closed as they were left, and move between them", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /docs/Default", "wait Rollout plan"])
    // Folders first, then documents, each one entry however many pages it has.
    await waitTree(page, ["v Demo 2", "  v plans 1", "    Plan B", "  Rollout plan", "A loose report"])

    // A folder closes, and stays closed when the page is opened again.
    await ui.run(["click Close Demo"])
    await waitTree(page, ["> Demo 2", "A loose report"])
    await page.reload()
    await ui.run(["wait A loose report"])
    await waitTree(page, ["> Demo 2", "A loose report"])
    await ui.run(["click Open Demo", "click Close Demo/plans"])
    await waitTree(page, ["v Demo 2", "  > plans 1", "  Rollout plan", "A loose report"])

    // Moving a document to a folder that isn't there yet makes it, with the folders there are suggested.
    await ui.run(["click Move A loose report", "wait Folder"])
    const suggested = await page.locator("datalist option").evaluateAll((os) => os.map((o) => o.value))
    assert.deepEqual(suggested, ["Demo", "Demo/plans"])
    await page.getByRole("combobox", { name: "Folder" }).fill(" Archive // 2026 ")
    await page.keyboard.press("Enter")
    await ui.run(["gone Move “A loose report”"])
    await waitTree(page, ["v Archive 1", "  v 2026 1", "    A loose report", "v Demo 2", "  > plans 1", "  Rollout plan"])
    assert.equal((await folders()).loose, "Archive/2026")

    // Renaming a folder moves everything in it, and a closed folder in it stays closed under its new name.
    await ui.run(["click Rename Demo", "wait Folder"])
    await page.getByRole("combobox", { name: "Folder" }).fill("Projects/Demo")
    await ui.run(["click css=[role=dialog] button[type=submit]", "gone Rename “Demo”"])
    await waitTree(page, ["v Archive 1", "  v 2026 1", "    A loose report", "v Projects 2", "  v Demo 2", "    > plans 1", "    Rollout plan"])
    assert.deepEqual(await folders(), { "rollout-plan": "Projects/Demo", "plan-b": "Projects/Demo/plans", loose: "Archive/2026" })

    // Dragged onto a folder, a document moves there.
    await page.getByRole("link", { name: "Rollout plan" }).dragTo(page.locator("tr[aria-label='Folder Archive']"))
    await waitTree(page, ["v Archive 2", "  v 2026 1", "    A loose report", "  Rollout plan", "v Projects 1", "  v Demo 1", "    > plans 1"])
    assert.equal((await folders())["rollout-plan"], "Archive")

    // A document's page names its folder.
    await ui.run(["click Rollout plan", "wait css=[aria-label=Folder]"])
    assert.equal(await page.locator("header [aria-label=Folder]").innerText(), "Archive")
  })
})

// HA-324: the Labels view, a tree of the documents' labels (the demo's "Rollout plan" has plans/releases), with each
// document under each of its labels and those with none under Unlabelled; a row's Labels button edits them.
test("the Labels view groups documents by their labels, and remembers it was chosen", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /docs/Default", "wait Rollout plan", "click role=radio[name=Labels]"])
    await waitTree(page, ["v plans 1", "  v releases 1", "    Rollout plan", "v Unlabelled 2", "  A loose report", "  Plan B"])

    // Labels added (one spelt as the profile spells it already), and one typed but not added yet, are saved.
    await ui.run(["click Labels of A loose report", "wait Add a label"])
    assert.ok((await page.locator("datalist option").evaluateAll((os) => os.map((o) => o.value))).includes("plans/releases"))
    await page.getByRole("combobox", { name: "New label" }).fill("PLANS/Releases")
    await page.keyboard.press("Enter")
    await page.getByRole("combobox", { name: "New label" }).fill("research")
    await ui.run(["click css=[role=dialog] button[type=submit]", "gone Add a label"])
    await waitTree(page, [
      "v plans 2",
      "  v releases 2",
      "    A loose report",
      "    Rollout plan",
      "v research 1",
      "  A loose report",
      "v Unlabelled 1",
      "  Plan B",
    ])
    const loose = (await server.rpc("docs.list", { profile_id: profile.id })).find((d) => d.slug === "loose")
    assert.deepEqual(loose.labels, ["plans/releases", "research"])

    // A label closes, and the page opens in the Labels view with it closed.
    await ui.run(["click Close plans"])
    await page.reload()
    await ui.run(["wait Unlabelled"])
    await waitTree(page, ["> plans 2", "v research 1", "  A loose report", "v Unlabelled 1", "  Plan B"])
  })
})
