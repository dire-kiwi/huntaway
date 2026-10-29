// Checks of scripts/ui-check.mjs itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

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
