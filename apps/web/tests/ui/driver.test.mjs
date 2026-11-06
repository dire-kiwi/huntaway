// Checks of scripts/ui-check.mjs itself.
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// Plans render in a sandboxed frame with no storage; signing in there used to throw a SecurityError.
test("a plan's sandboxed frame raises no errors, and errors in the page and the frame are still caught", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const plan = tasks.find((t) => t.title === "Plan a dark mode for the demo site");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"]);
    const frame = page.frameLocator("iframe").first();
    await frame.getByRole("heading", { name: "Dark mode", exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(ui.errors, []);

    await page.evaluate(() => setTimeout(() => { throw new Error("boom in the page"); }));
    const child = page.frames().find((f) => f !== page.mainFrame());
    await child.evaluate(() => setTimeout(() => { throw new Error("boom in the frame"); }));
    await page.waitForTimeout(300);
    assert.equal(ui.errors.length, 2, ui.errors.join("\n"));
    assert.match(ui.errors.join("\n"), /boom in the page[^]*boom in the frame|boom in the frame[^]*boom in the page/);
    ui.errors.length = 0;
  });
});

// A target's ways of matching are counted one at a time, so a page that renders in between used to have its substring
// match win: `click terminal` clicked a card titled "Terminal rendering" instead of the task's terminal tab (HA-195).
test("an exact match that renders while a target is looked up wins over a partial one", async () => {
  let render;
  await withBrowser(server, { onMiss: () => render?.() }, async (ui) => {
    const { page } = ui;
    await page.route(`${server.url}/ui-check-race`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await ui.run(["goto /ui-check-race"]);
    // Rendered after the exact match came up empty, before the partial one is counted.
    render = async () => {
      render = undefined;
      await page.evaluate(() => {
        document.body.innerHTML = `<div onclick="window.clicked = 'card'">Terminal rendering</div><button onclick="window.clicked = 'tab'">terminal</button>`;
      });
    };
    await ui.run(["click terminal"]);
    assert.equal(render, undefined, "the page rendered between the counts");
    assert.equal(await page.evaluate(() => window.clicked), "tab");
  });
});
