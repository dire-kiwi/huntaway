import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

const scrolled = (page) => page.evaluate(() => document.querySelector("main").scrollTop);

// The guide in the app: opened from the sidebar and from a setting's link, its links between pages and to headings
// staying in the app (Back goes back), and a link outside the guide going to GitHub.
test("the guide's pages open in the app and link to each other", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}/settings/workflows`, 'click role=link[name="Workflows"]', "wait Column nodes"]);
    assert.equal(new URL(page.url()).pathname, "/guide/workflows");

    // A section in the page's contents, then a link in the text to the end of the page.
    await ui.run(['click role=navigation[name="Guide pages"] >> text=An example', "wait Work, PR and review"]);
    assert.equal(new URL(page.url()).hash, "#an-example");
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 1000);

    // Another page starts at its top, and its link to this one comes back to it.
    await ui.run(["click Asana and automations", "wait Asana tasks"]);
    assert.equal(await scrolled(page), 0);
    await page.locator('main a[href="/guide/workflows"]').first().click();
    await ui.run(["wait Column nodes"]);
    await page.goBack();
    await ui.run(["wait Asana tasks"]);
    assert.equal(new URL(page.url()).pathname, "/guide/integrations");

    // Opened at a heading, and a link out of the guide is to the file on GitHub.
    await ui.run(["goto /guide/hosts#running-a-host-as-a-service", "wait Running a host as a service"]);
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 300);
    const broker = await page.locator('main a:text("Configure the broker")').getAttribute("href");
    assert.equal(broker, "https://github.com/dire-kiwi/huntaway/blob/master/rust/broker/README.md");

    await ui.run(["goto /", "click role=button[name=/Guide/]", "wait Using the board"]);
    assert.equal(new URL(page.url()).pathname, "/guide");
    await ui.run(["goto /guide/nope", "wait has no page"]);
  });
});
