import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// HA-5: the board's other views (Triage, Live, Timeline and Graph) show its tasks, and the view picked stays.
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

    // Timeline: the demo's tasks have never run.
    await ui.run(["click Timeline view", "wait Agents running", "wait Nothing ran in this window"]);

    // Live: the task waiting on an answer gets a tile to answer it from.
    await ui.run(["click Live view", "wait A task waiting on an answer", "wait css=input[placeholder='Reply to the agent…']"]);

    // The view is kept for the next visit.
    await ui.run([`goto /p/${project.id}`, "wait css=input[placeholder='Reply to the agent…']", "click Board view", "wait Merged and closed"]);
  });
});
