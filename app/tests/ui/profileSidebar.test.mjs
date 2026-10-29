import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, demo;
before(async () => {
  // Two profiles: "Default" with the Demo project, and "test" with the Test project.
  server = startServer("--seed");
  demo = await demoProject(server);
});
after(() => server?.stop());

const demoRow = "css=aside >> role=button[name=/^DEM Demo/]";
const testRow = "css=aside >> role=button[name=/^TES Test/]";
const current = "document.querySelector('aside [aria-current]')?.textContent";

// IA-128: the sidebar lists the active profile's projects, marks that profile, and keeps pinned projects on every profile's list.
test("lists the active profile's projects and the pinned ones", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /", `wait ${demoRow}`, `gone ${testRow}`, `assert ${current}.startsWith('DDefault')`]);
    assert.match(await page.locator("aside").innerText(), /PROJECTS · Default/i);

    // Picking a profile lists its projects, and it stays picked off the boards and on the next visit.
    await ui.run(["click css=aside >> role=button[name=/^t test/]", `wait ${testRow}`, `gone ${demoRow}`, "goto /settings", `wait ${testRow}`]);
    await ui.run(["goto /", `wait ${testRow}`, "assert location.pathname === '/profile/test'"]);

    // A pinned project stays listed under the other profile, and opening it doesn't move away from that profile.
    await ui.run([`rclick ${testRow}`, "click [role=menu] >> text=Pin to every profile", "click css=aside >> role=button[name=/^D Default/]"]);
    await ui.run([`wait ${demoRow}`, `wait ${testRow}`, `click ${testRow}`, "wait css=header >> text=Test", `assert ${current}.startsWith('DDefault')`]);
    await ui.run(["goto /", `wait ${testRow}`, "assert location.pathname === '/profile/Default'"]);

    // Opening a project the sidebar doesn't list moves to its profile.
    await ui.run([`rclick ${testRow}`, "click [role=menu] >> text=Unpin", `gone ${testRow}`, "click css=aside >> role=button[name=/^t test/]", `wait ${testRow}`]);
    await ui.run([`goto /p/${demo.id}`, `wait ${demoRow}`, `gone ${testRow}`, `assert ${current}.startsWith('DDefault')`]);
  });
});

// IA-128 review: a profile's group tasks keep a group listed after its own projects leave it, so opening the group (or one of
// the tasks) keeps that profile even while the group still has another profile's projects.
test("opening a group the profile only has group tasks in keeps the profile", async () => {
  const profiles = await server.api("GET", "/profiles");
  const testProfile = profiles.find((p) => p.name === "test");
  const [testProject] = await server.api("GET", `/profiles/${testProfile.id}/projects`);
  await server.api("PATCH", `/projects/${demo.id}`, { group_name: "Shared" });
  await server.api("PATCH", `/projects/${testProject.id}`, { group_name: "Shared" });
  const task = await server.api("POST", `/profiles/${testProfile.id}/group-tasks`, { group: "Shared", description: "Plan across Shared", status: "todo" });
  await server.api("PATCH", `/projects/${testProject.id}`, { group_name: null });

  await withBrowser(server, {}, async (ui) => {
    const shared = "css=aside >> role=button[name=/^Shared$/]";
    await ui.run(["goto /profile/test", `wait ${testRow}`, `click ${shared}`, `wait css=header >> text=Shared`, "sleep 300"]);
    await ui.run([`assert ${current}.startsWith('ttest')`, `wait ${shared}`, `gone ${demoRow}`]);
    await ui.run([`goto /t/${task.id}`, "wait css=header >> text=Shared", "sleep 300", `assert ${current}.startsWith('ttest')`, `wait ${shared}`]);
    await ui.run(["goto /", `wait ${testRow}`, "assert location.pathname === '/profile/test'"]);
  });
});
