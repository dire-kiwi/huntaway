import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const DONE = "Merged and closed";
const ARCHIVED = "Shipped last week";

const statusOf = async (title) => (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.title === title);

// HA-156: a done task, archived or not, goes back to To do or Backlog from its right-click menu, not only by dragging.
test("a done task moves back to To do or Backlog from its right-click menu", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, `wait ${DONE}`, `rclick ${DONE}`, "wait [role=menu]"]);
    // The statuses to move to, then Done's resolutions.
    const labels = await page.locator("[role=menu] [role^=menuitem]").allTextContents();
    for (const l of ["Backlog", "To do", "In progress", "Won't fix"]) assert.ok(labels.some((t) => t.includes(l)), `${l} in ${labels}`);
    await ui.run(["click [role=menu] >> text=Backlog", "gone [role=menu]"]);
    await expect_status(DONE, "backlog");
    assert.equal((await statusOf(DONE)).resolution, null);

    // An archived task, in the list view, goes back to To do.
    await ui.run(["click List view", "click css=#archived-tasks button", `wait ${ARCHIVED}`, `rclick ${ARCHIVED}`, "wait [role=menu]", "click [role=menu] >> text=To do"]);
    await expect_status(ARCHIVED, "todo");
    assert.equal((await statusOf(ARCHIVED)).resolution, null);
  });
});

async function expect_status(title, status) {
  for (let i = 0; i < 50; i++) {
    if ((await statusOf(title)).status === status) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await statusOf(title)).status, status);
}
