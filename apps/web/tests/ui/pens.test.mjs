import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

const DRAG = "Try dragging this card to another column";
const WAITING = "A task waiting on an answer";
const tab = (name) => `role=tab[name=/^${name}/]`;
const selectedTab = (page) => page.evaluate(() => document.querySelector("[role=tab][aria-selected=true]")?.textContent ?? "");

/** The demo profile's tasks as the server has them, by title. */
async function tasks() {
  const list = await server.api("GET", `/projects/${project.id}/tasks`);
  return Object.fromEntries(list.map((t) => [t.title, t]));
}

/** Waits until `f(tasks)` holds on the server. */
async function until(f, what) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (f(await tasks())) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// HA-285: pens are the profile board's tabs. A task goes in one from its card's menu, by being dropped on its tab, or by
// being made on its tab; a pen can be hidden and shown again, and the board stays on the tab picked last.
test("tasks move into pens, which show as the profile board's tabs", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "wait Pens thread", "click New pen", "type Today", "press Enter", "gone Create pen", `wait ${tab("Today")}`]);
    assert.match(await selectedTab(page), /^Today/);
    // A task made on the pen's tab goes in the pen (the task the server returns has no host_id of its own).
    await ui.run(["click New task", "type Made on the Today tab", "press Control+Enter", "gone Create task"]);
    const pens = await server.api("GET", `/profiles/${project.profile_id}/pens`);
    const today = pens.find((p) => p.name === "Today");
    await until((ts) => Object.values(ts).some((t) => t.description?.includes("Made on the Today tab") && t.pen_id === today.id), "the new task in the pen");

    // From a card's menu, on the All tab.
    await ui.run([`click ${tab("All")}`, `rclick ${DRAG}`, "click [role=menu] >> text=Pen: Today", "gone [role=menu]"]);
    await until((ts) => ts[DRAG].pen_id === today.id, "the card in the pen");
    // Dropped on the tab.
    await page.evaluate(
      ([title, name]) => {
        const card = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(title));
        const target = [...document.querySelectorAll("[role=tab]")].find((e) => e.textContent.startsWith(name));
        const dataTransfer = new DataTransfer();
        dataTransfer.setData("text/task-id", card.dataset.task);
        for (const type of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
      },
      [WAITING, "Today"],
    );
    await until((ts) => ts[WAITING].pen_id === today.id, "the dropped card in the pen");
    await ui.run([`click ${tab("Today")}`, `wait ${DRAG}`, `wait ${WAITING}`, "gone Edit this task's title and description"]);
    assert.match(await selectedTab(page), /^Today\s*3$/);

    // The board stays on it after a reload.
    await ui.run(["goto /profile/Default", `wait ${DRAG}`, "gone Edit this task's title and description"]);
    assert.match(await selectedTab(page), /^Today/);

    // Hidden, it's off the tabs (the board goes back to All) until it's shown again.
    await ui.run([
      `rclick ${tab("Today")}`,
      "click [role=menu] >> text=Hide",
      "wait 1 hidden",
      `gone ${tab("Today")}`,
      "wait Edit this task's title and description",
    ]);
    assert.match(await selectedTab(page), /^All/);
    await ui.run(["click 1 hidden", "click [role=menu] >> text=Today", `wait ${tab("Today")}`, "gone 1 hidden"]);

    // Out of the pen from its menu.
    await ui.run([`rclick ${DRAG}`, "click [role=menu] >> text=Out of Today", "gone [role=menu]", `gone ${DRAG}`]);
    await until((ts) => ts[DRAG].pen_id === null, "the card out of the pen");
  });
});

// The pens thread opens beside the board on its thread, keyed among the scratch tasks, and isn't a card on the board.
test("the pens thread opens beside the board", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "click Pens thread", "wait This thread keeps your pens"]);
    const url = new URL(page.url());
    assert.equal(url.pathname, "/profile/Default");
    const thread = await server.api("GET", `/profiles/${project.profile_id}/pens-thread`);
    assert.equal(url.searchParams.get("task"), thread.id);
    await ui.run([`wait S-${thread.number}`, "gone role=button[name=/^Start$/]"]);
    assert.equal(await page.locator(`[data-task="${thread.id}"]`).count(), 0);
  });
});
