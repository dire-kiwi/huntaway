import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { startServer, withBrowser } from "./harness.mjs"

let server
beforeAll(() => {
  // The demo board runs the example `notes` plugin.
  server = startServer("--demo")
})
afterAll(() => server?.stop())

// HE-34 (docs/plan/15-plugins.md): a plugin's page is `/<plugin id>/<path>`, in its frame, with a menu entry; a first
// segment that names no plugin (an old link, a typo) still lands home, as before plugins.
test("a plugin's page opens from the menu and shows in its frame; an unknown page goes home", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /", "click css=nav[aria-label=Plugins] >> text=Notes"])
    // Its first page sends the board on to the first profile's.
    await page.waitForFunction(() => /^\/notes\/[0-9a-f-]+$/.test(location.pathname))
    await page.frameLocator("iframe").getByText("No notes yet.").waitFor()
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts")

    await ui.run(["goto /nosuchpage/x", "wait css=nav[aria-label=Profiles]"])
    await page.waitForFunction(() => location.pathname.startsWith("/profile/"))
    assert.equal(await page.getByText("nosuchpage").count(), 0)
  })
})
