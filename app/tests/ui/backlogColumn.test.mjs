import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const PARKED = "An idea for later";
const TITLE = "Edit this task's title and description";

// IA-125: backlog tasks were left off the kanban board, so a task an agent moved there seemed to vanish.
// The board ends in a Backlog column that starts collapsed, takes drops while collapsed and remembers being open.
test("the kanban board's Backlog column collapses, opens and takes drops", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Show the backlog (1)", `gone ${PARKED}`]);

    // A card dropped on the collapsed strip goes to the backlog.
    await page.locator("[data-task]", { hasText: TITLE }).dragTo(page.getByTitle(/Show the backlog/));
    await ui.run(["wait Show the backlog (2)", `gone ${TITLE}`]);
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    assert.equal(tasks.find((t) => t.title === TITLE).status, "backlog");

    // Opened, it shows its tasks, and stays open over a reload until collapsed again.
    await ui.run(["click Show the backlog", `wait ${PARKED}`, `wait ${TITLE}`, `goto /p/${project.id}`, `wait ${PARKED}`]);
    await ui.run(["click Collapse the backlog", `gone ${PARKED}`, `goto /p/${project.id}`, "wait Show the backlog", `gone ${PARKED}`]);
  });
});

// IA-125 review: a profile's board with no projects (IA-120) has the Backlog column too, and its tasks can be dropped on it.
test("a profile's board with no projects has a Backlog column that takes drops", async () => {
  const lab = await server.api("POST", "/profiles", { name: "lab" });
  await server.api("POST", `/profiles/${lab.id}/tasks`, { title: "Old question", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/lab", "wait Old question", "wait Show the backlog (0)"]);
    await page.locator("[data-task]", { hasText: "Old question" }).dragTo(page.getByTitle(/Show the backlog/));
    await ui.run(["wait Show the backlog (1)", "gone Old question"]);
    const tasks = await server.api("GET", `/profiles/${lab.id}/tasks`);
    assert.equal(tasks.find((t) => t.title === "Old question").status, "backlog");
    await ui.run(["click Show the backlog", "wait Old question", "wait New task in Backlog", "click Collapse the backlog", "gone Old question"]);
  });
});

// IA-125: the backlog comes first in both views, collapsed until opened (in one view, which opens it in the other).
test("the backlog is first and starts collapsed in the board and list views", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // The first column's (or list section's) label.
    const first = () => page.evaluate(() => document.querySelector("section")?.textContent);
    await ui.run([`goto /p/${project.id}`, "wait Show the backlog"]);
    assert.match(await first(), /^\d*Backlog$/);

    await ui.run(["click List view", "wait css=section h2", `gone ${PARKED}`]);
    assert.match(await first(), /^Backlog\d+/);
    await ui.run(["click css=section >> text=Backlog", `wait ${PARKED}`, "click Board view", "wait Collapse the backlog", `wait ${PARKED}`]);
    await ui.run(["click Collapse the backlog", `gone ${PARKED}`]);
  });
});
