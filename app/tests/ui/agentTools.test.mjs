import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-63: switches clicked before the previous save came back used to send a stale list, so a click was lost.
test("fast clicks on skill switches all reach the server", async () => {
  const names = ["alpha", "beta", "gamma"];
  await server.api("PATCH", `/projects/${project.id}/agent-tools`, { disabled_skills: names });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // Slow saves, so every click lands while an earlier one is still saving.
    await page.route("**/agent-tools", async (route) => {
      if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await ui.run([`goto /p/${project.id}/settings/tools`, "click Skills from Claude configs"]);
    for (const name of names) await page.getByRole("button", { name, exact: true }).click();
    let saved;
    for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100)) {
      saved = (await server.api("GET", `/projects/${project.id}/agent-tools`)).disabled_skills;
      if (!saved.length) break;
    }
    assert.deepEqual(saved, []);
    // Switched back on and never seen in a run, they're no longer listed, before or after a reload.
    await ui.run(["wait none seen yet", `goto /p/${project.id}/settings/tools`, "wait none seen yet"]);
  });
});
