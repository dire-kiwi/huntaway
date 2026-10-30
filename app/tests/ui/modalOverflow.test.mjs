import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Whether `name`'s button in the dialog is inside the window, top to bottom. */
const inView = (page, name) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name })
    .evaluate((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });

// HA-24: a dialog taller than the window ran off its bottom, with no way to scroll to its buttons. It fits the window
// now: its fields scroll, and its buttons stay at its bottom.
test("a dialog taller than the window keeps its buttons in view", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["size 1200x450", `goto /p/${project.id}`, "click New task", "wait [role=dialog]"]);
    assert.ok(await inView(page, /^Create task/), "the new task dialog's Create button is in the window");
    await ui.run(["click Cancel", "gone [role=dialog]"]);

    await ui.run(["size 1200x600", `goto /p/${project.id}/settings`, "click New automation", "wait Add automation"]);
    const body = page.getByRole("dialog").locator(".overflow-y-auto").first();
    const { scrollHeight, clientHeight } = await body.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    assert.ok(scrollHeight > clientHeight, `the automation dialog's fields scroll (${scrollHeight} > ${clientHeight})`);
    assert.ok(await inView(page, "Add automation"), "its Add button is in the window with the fields at the top");
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    assert.ok(await inView(page, "Add automation"), "and with them at the bottom");

    // And it still saves from there.
    await ui.run([
      "click Weekly dependency update",
      "type Nightly check",
      "click Update dependencies ({{date}})",
      "type Check the nightly build",
      "click Add automation",
      "gone [role=dialog]",
    ]);
    await ui.run(["wait Nightly check"]);
    assert.match(JSON.stringify(await server.api("GET", `/projects/${project.id}/automations`)), /"name":"Nightly check"/, "the automation was saved");
  });
});
