import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-121: an archived project goes off the board (sidebar and its profile's board, after a reload too), and comes back,
// tasks and all, from Settings → Archived projects.
test("archives a project from the sidebar and unarchives it in Settings", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const row = "css=aside >> role=button[name=/^DEM Demo/]";
    const task = "Something being worked on";
    await ui.run([`goto /p/${project.id}`, `wait ${row}`, `rclick ${row}`, "click [role=menu] >> text=Archive…", "wait Archive Demo"]);
    await ui.run(["click [data-modal] >> role=button[name='Archive project']", "gone Archive Demo", `gone ${row}`]);
    await page.waitForURL(/\/profile\/Default$/);
    await ui.run(["wait Try a scratch task"]);
    assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(task), "its tasks are off the profile's board");

    await ui.run([`goto /p/${project.id}`, "wait Demo is archived"]);
    assert.doesNotMatch(await page.locator("aside").innerText(), /Demo/, "still archived after a reload");
    assert.equal((await server.api("GET", `/profiles/${project.profile_id}/projects`)).some((p) => p.id === project.id), false);

    await ui.run(["click Unarchive it in Settings", "wait Archived projects", "click role=button[name='Unarchive']", "wait No archived projects", `wait ${row}`]);
    // Its tasks are loaded again without a reload.
    await ui.run(["click css=nav[aria-label=Profiles] >> text=Default", `wait ${task}`]);
  });
});
