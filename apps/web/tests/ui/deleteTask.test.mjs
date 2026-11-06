import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// HA-32: a deletion that failed (the host offline, or a 409 while the task merges) closed the dialog and the panel as if
// it had worked, leaving the task on the board with no word of why.
test("a deletion that fails says so and keeps the dialog open", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Stays put" });
  await withBrowser(server, { allowErrors: [/status of 409/] }, async (ui) => {
    const { page } = ui;
    await page.route(/\/api\/h\/[^/]+\/tasks\/[^/?]+\?delete_branch=/, (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "the task is being merged" }) }),
    );
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", "click Delete task", "wait This stops any running agent"]);
    await page.getByRole("button", { name: /^Delete$/ }).click();
    await ui.run(["wait the task is being merged"]);
    assert.ok(await page.getByRole("button", { name: /^Delete$/ }).isVisible(), "the dialog stays open");
    assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.title, "Stays put");
  });
});
