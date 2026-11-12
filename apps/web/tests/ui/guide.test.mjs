import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedBoard, startServer, withBrowser } from "./harness.mjs"

let server
beforeAll(async () => {
  server = startServer()
  await seedBoard(server)
})
afterAll(() => server?.stop())

const scrolled = (page) => page.evaluate(() => document.querySelector("main").scrollTop)

// The guide in the app: opened from the sidebar, its links between pages and to headings staying in the app (Back goes
// back), and a link outside the guide going to GitHub. (The old check opened it first from the Workflows tab's link to
// it, which is 6.6's: this one opens that page by its address.)
test("the guide's pages open in the app and link to each other", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /guide/workflows", "wait Column nodes"])

    // A section in the page's contents, then a link in the text to the end of the page.
    await ui.run(['click role=navigation[name="Guide pages"] >> text=An example', "wait Work, PR and review"])
    assert.equal(new URL(page.url()).hash, "#an-example")
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 1000)

    // Another page starts at its top, and its link to this one comes back to it.
    await ui.run(["click Asana and automations", "wait Asana tasks"])
    assert.equal(await scrolled(page), 0)
    await page.locator('main a[href="/guide/workflows"]').first().click()
    await ui.run(["wait Column nodes"])
    await page.goBack()
    await ui.run(["wait Asana tasks"])
    assert.equal(new URL(page.url()).pathname, "/guide/integrations")

    // Opened at a heading, and a link out of the guide is to the file on GitHub (the old repository's, whose pages
    // these are until 9.3 brings them into line).
    await ui.run(["goto /guide/hosts#running-a-host-as-a-service", "wait Running a host as a service"])
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 300)
    await ui.run(["goto /guide/agents", "wait docs/threads.md"])
    const threads = await page.locator('main a:text("docs/threads.md")').first().getAttribute("href")
    assert.equal(threads, "https://github.com/dire-kiwi/huntaway/blob/master/docs/threads.md")

    await ui.run(["goto /", "click role=button[name=/Guide/]", "wait Using the board"])
    assert.equal(new URL(page.url()).pathname, "/guide")
    await ui.run(["goto /guide/nope", "wait has no page"])
  })
})
