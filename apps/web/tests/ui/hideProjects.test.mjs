import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const sidebar = (page) => page.locator("aside").innerText();

// IA-118: a project hidden from the sidebar goes under the "hidden" row, keeps its counts there, and stays hidden after a reload.
test("hides a project from the sidebar and shows it again", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const row = "css=aside >> role=button[name=/^DEM Demo/]";
    await ui.run(["goto /", `wait ${row}`, `rclick ${row}`, "click [role=menu] >> text=Hide from sidebar", `gone ${row}`, "wait 1 hidden"]);
    // Closed, the hidden row carries the project's counts: 4 in review and ready, 1 needing attention.
    assert.match(await sidebar(page), /1 hidden\s+4\s+1\s/);

    await ui.run(["goto /", "wait 1 hidden"]);
    assert.doesNotMatch(await sidebar(page), /Demo/, "still hidden after a reload");

    await ui.run(["click 1 hidden", `wait ${row}`, `click ${row}`]);
    assert.equal(new URL(page.url()).pathname, `/p/${project.id}`);
    await ui.run([`rclick ${row}`, "click [role=menu] >> text=Show in sidebar", "gone 1 hidden", `wait ${row}`]);
    await ui.run(["goto /", `wait ${row}`]);
    assert.doesNotMatch(await sidebar(page), /hidden/);
  });
});
