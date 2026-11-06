import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// HA-25: the project settings are in tabs down the side. Changes on one tab are kept while another is open, the tabs
// with any are marked, and Save changes saves them all, from any tab.
test("unsaved changes are kept across the tabs and saved together", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
    const panel = page.getByRole("tabpanel");
    // An unknown tab is the first one.
    await ui.run([`goto /p/${project.id}/settings/nope`, "wait Danger zone"]);
    assert.equal(await tab("General").getAttribute("aria-selected"), "true");

    await panel.getByLabel("Name").fill("Renamed");
    await tab("Worktrees").click();
    await page.waitForURL(/\/settings\/worktrees$/);
    await panel.getByLabel("Base branch").fill("main");
    await ui.run(["wait Unsaved changes in General, Worktrees"]);
    assert.equal(await tab("General").getByLabel("Unsaved changes").count(), 1);
    assert.equal(await tab("Agents").getByLabel("Unsaved changes").count(), 0);

    await tab("General").click();
    assert.equal(await panel.getByLabel("Name").inputValue(), "Renamed");

    // Saved from a tab that saves as it goes.
    await tab("Automations").click();
    await ui.run(["wait New automation", "click Save changes", "gone Save changes"]);
    const saved = await server.api("GET", `/projects/${project.id}`);
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.base_branch, "main");

    // A change put back as it was isn't one, and Discard drops the others.
    await page.reload();
    await ui.run(["wait New automation"]);
    await tab("Worktrees").click();
    await panel.getByLabel("Base branch").fill("dev");
    await panel.getByLabel("Base branch").fill("main");
    await tab("General").click();
    await panel.getByLabel("Key").fill("RNM");
    await ui.run(["wait Unsaved changes in General"]);
    assert.equal(await tab("Worktrees").getByLabel("Unsaved changes").count(), 0);
    await ui.run(["click Discard", "gone Unsaved changes"]);
    assert.equal(await panel.getByLabel("Key").inputValue(), project.key);
  });
});
