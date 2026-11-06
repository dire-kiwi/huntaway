import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// HA-5: the board's other views (Triage and Graph) show its tasks, and the view picked stays.
test("the board's other views show its tasks, and the one picked stays", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const first = tasks.find((t) => t.title === "Try dragging this card to another column");
  const second = tasks.find((t) => t.title === "Edit this task's title and description");
  await server.api("PATCH", `/tasks/${second.id}`, { depends_on: [first.id] });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Merged and closed"]);

    // Triage: what needs an answer comes before what needs a review, and the one picked can be answered in place.
    await ui.run(["click Triage view", "wait Waiting for your answer", "wait Ready for your review", "wait A task waiting on an answer"]);
    const sections = await page.evaluate(() => [...document.querySelectorAll("section h3")].map((h) => h.textContent));
    assert.deepEqual(sections.slice(0, 2), ["Waiting for your answer", "Ready for your review"]);
    await ui.run(["press j", "wait css=[data-triage] textarea"]);

    // Graph: the task that waits for another follows it, and the rest are listed apart.
    await ui.run(["click Graph view", "wait Not linked to other tasks", "wait Finished work to look over"]);
    await page.waitForFunction(() => document.querySelectorAll("path[marker-end='url(#arrow-depends)']").length === 1);

    // The view is kept for the next visit.
    await ui.run([`goto /p/${project.id}`, "wait Not linked to other tasks", "click Board view", "wait Merged and closed"]);
  });
});

// Clients that last used a removed view should still get a usable board.
for (const view of ["live", "timeline"]) {
  test(`saved ${view} view falls back to Board`, async () => {
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      await page.addInitScript((view) => localStorage.setItem("ia.boardView", view), view);
      await ui.run([`goto /p/${project.id}`, "wait Merged and closed"]);
      assert.equal(await page.getByTitle(/^Live view/).count(), 0);
      assert.equal(await page.getByTitle(/^Timeline view/).count(), 0);
      await ui.run(["click List view", "wait Merged and closed", "click Board view", "wait Merged and closed"]);
    });
  });
}
