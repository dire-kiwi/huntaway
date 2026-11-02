import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  // Agents run with scripts/fake-claude, so a started task's agent runs without a model.
  server = startServer("--fake-claude");
  project = await demoProject(server);
});
after(() => server?.stop());

// The task once the dialog's request has made it (the dialog closing doesn't wait for the board to show it).
const byDescription = async (description) => {
  for (let i = 0; i < 100; i++) {
    const t = (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.description === description);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no task "${description}"`);
};

// HA-109: the new task dialog sends the prompt as the description with `start: true`, which is the user's prompt, so
// "Create & start" puts the task in Now. Creating without starting leaves it in Later.
test("a task made with Create & start is in Now, one only created is in Later", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click New task", "type Say hello from the dialog"]);
    const toggle = page.getByRole("switch", { name: "Start agent now" });
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await ui.run(["press Control+Enter", "gone Create & start"]);
    const started = await byDescription("Say hello from the dialog");
    assert.ok(started.now_at, "the prompt put it in Now");

    await ui.run(["click New task", "type Only make this one"]);
    const again = page.getByRole("switch", { name: "Start agent now" });
    if ((await again.getAttribute("aria-checked")) === "true") await again.click();
    await ui.run(["press Control+Enter", "gone Only make this one"]);
    const made = await byDescription("Only make this one");
    assert.equal(made.now_at, null, "no prompt, so it's in Later");

    // The Now view shows the started one, not the other.
    await ui.run(["click Only the tasks in Now"]);
    await page.waitForFunction((id) => !!document.querySelector(`[data-task="${id}"]`), started.id);
    assert.equal(await page.locator(`[data-task="${made.id}"]`).count(), 0);
  });
});
