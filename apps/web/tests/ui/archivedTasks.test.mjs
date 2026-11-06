import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const OLD = "Shipped last week";
const RECENT = "Merged and closed";

// IA-142: tasks done for two days leave the kanban board's Done column for the list view's Archived section,
// and dragging one back into Done brings it back.
test("tasks done for two days are archived, in the list view only", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, `wait ${RECENT}`, "wait 1 archived", `gone ${OLD}`]);

    // The Done column links to them, in the list view's Archived section, which starts collapsed.
    await ui.run(["click 1 archived", `wait ${OLD}`, "click List view"]);
    await ui.run(["click css=#archived-tasks button", `gone ${OLD}`, `goto /p/${project.id}`, "wait css=#archived-tasks", `gone ${OLD}`]);
    await ui.run(["click css=#archived-tasks button", `wait ${OLD}`, `goto /p/${project.id}`, `wait ${OLD}`]);
    assert.match(await page.locator("#archived-tasks").textContent(), /^Archived1/);

    // Dragged into Done, it's done from now on.
    await page.locator("[data-task]", { hasText: OLD }).dragTo(page.locator("[data-task]", { hasText: RECENT }));
    await page.waitForFunction(() => /^Archived0/.test(document.querySelector("#archived-tasks")?.textContent ?? ""));
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    const t = tasks.find((t) => t.title === OLD);
    assert.equal(t.status, "done");
    assert.ok(Date.now() - Date.parse(t.done_at) < 60_000, t.done_at);
    await ui.run(["click Board view", `wait ${OLD}`, "gone 1 archived"]);
  });
});
