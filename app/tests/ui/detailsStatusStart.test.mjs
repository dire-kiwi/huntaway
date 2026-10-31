import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  // Agents run with scripts/fake-claude, which logs each call and answers without a model.
  server = startServer("--fake-claude");
  project = await demoProject(server);
});
after(() => server?.stop());

// HA-32: moving a fresh task to In progress from its Details tab only changed its column, where a drop on the board
// starts its agent too.
test("In progress from a task's Details starts its agent", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Start me", description: "Say hello." });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details"]);
    await page.locator("aside button", { hasText: "In progress" }).click();
    await ui.run(["click Thread", "wait Fake reply to:"]);
  });
  // The fake agent's run ends at once, which moves the task on to In review.
  assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.status, "in_review");
  const log = `${server.dataDir}/fake-claude.log`;
  assert.ok(existsSync(log) && readFileSync(log, "utf8").includes("Say hello."), "the agent was started with the task");
});
