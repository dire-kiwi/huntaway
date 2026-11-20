import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"

// HE-63: the docs plugin 0.3.0's editors on the board. A document made with the plugin's own `doc.save` (the editor's
// New document) has a page and a mockup (a page published as HTML).

let server, profile
beforeAll(async () => {
  server = startServer()
  profile = await makeProfile(server)
})
afterAll(() => server?.stop())

const save = (title, pages) =>
  server.rpc("plugins.call", {
    plugin: "docs",
    method: "doc.save",
    payload: { profile: profile.id, slug: null, base_version: null, title, folder: null, message: null, pages, images: [] },
  })

// The editor's Save goes to the document straight away. The board used to show it a render kept from before the edit,
// and then the new one, in the same new frame: Chromium left that frame without a layout (blank, though its text was
// there), and the Edit link opened the old source, so the next Save asked to save over a version.
test("Save in the document editor shows the new version, laid out, and Edit opens what was saved", async () => {
  const { slug } = await save("Notes", [{ path: "index", format: "md", content: "# Notes\n\nFirst.\n" }])
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const doc = page.frameLocator("iframe").first()
    await ui.run([`goto /docs/${profile.id}/d/${slug}/`])
    await doc.getByText("First.").waitFor()
    for (const n of [1, 2, 3]) {
      await doc.getByText("Edit", { exact: true }).click()
      const source = doc.locator("textarea").first()
      await source.waitFor()
      // What the last Save published, not the source from before it.
      await eventually(async () => assert.match(await source.inputValue(), n === 1 ? /First\./ : new RegExp(`Saved ${n - 1}\\.`)))
      await source.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type(`\n\nSaved ${n}.\n`)
      await doc.getByRole("button", { name: "Save" }).click()
      // Visible needs a box: a frame without a layout has none, though its text is in the DOM.
      await doc.getByText(`Saved ${n}.`).waitFor({ state: "visible" })
      await doc.getByText(`Version ${n + 1} (latest)`).waitFor({ state: "visible" })
      const box = await page.locator("iframe").first().boundingBox()
      assert.ok(box !== null && box.height > 100)
    }
  })
})

// A mockup's page is the design editor; with `?details` it is its document's page (labels, versions, publishing),
// which the board shows only if it gives the page its query string.
test("a mockup's Document details opens its document's page", async () => {
  const { slug } = await save("Screens", [{ path: "home", format: "html", content: "<!doctype html><html><body><h1>Home mockup</h1></body></html>" }])
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const doc = page.frameLocator("iframe").first()
    await ui.run([`goto /docs/${profile.id}/d/${slug}/`])
    await doc.getByText("Document details…").click()
    await page.waitForFunction(() => new URLSearchParams(location.search).has("details"))
    await doc.getByText("Labels", { exact: true }).waitFor({ state: "visible" })
    await doc.getByText("Delete", { exact: true }).waitFor({ state: "visible" })
  })
})
