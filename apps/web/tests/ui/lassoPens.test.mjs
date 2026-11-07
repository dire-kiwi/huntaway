import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// The ids of the demo project's tasks in pen `name`.
const penIds = async (name) => {
  const pens = await server.api("GET", `/profiles/${project.profile_id}/pens`);
  const pen = pens.find((p) => p.name === name);
  if (!pen) return [];
  return (await server.api("GET", `/projects/${project.id}/tasks`))
    .filter((t) => t.pen_id === pen.id)
    .map((t) => t.id)
    .sort();
};
/** Waits for pen `name` to have `ids`. */
const until = async (page, name, ids) => {
  for (let i = 0; i < 50 && JSON.stringify(await penIds(name)) !== JSON.stringify(ids); i++) await page.waitForTimeout(100);
  assert.deepEqual(await penIds(name), ids);
};
const boxOf = (page, id) =>
  page.evaluate((id) => {
    const r = document.querySelector(`[data-task="${id}"]`).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, id);

// HA-109, HA-285: Ctrl + right-drag draws a lasso round cards, and the bar it brings puts the picked tasks in a pen.
test("the lasso picks tasks, and its bar and their menus put them in a pen", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Merged and closed"]);
    const cardIds = await page.evaluate(() => [...document.querySelectorAll("[data-task]")].map((c) => c.dataset.task));
    assert.ok(cardIds.length >= 4);
    // The lasso goes round two in the In review column, one above the other.
    const idOf = (title) => tasks.find((t) => t.title === title).id;
    const first = cardIds[0];
    const [second, third] = [idOf("Finished work to look over"), idOf("How a task moves across the board")];
    assert.ok(![second, third].includes(first));

    // The lasso: Ctrl and the right button, dragged round two cards. The browser's menu doesn't open.
    const a = await boxOf(page, second);
    const b = await boxOf(page, third);
    const left = Math.min(a.left, b.left) - 6;
    const right = Math.max(a.right, b.right) + 6;
    const top = Math.min(a.top, b.top) - 6;
    const bottom = Math.max(a.bottom, b.bottom) + 6;
    await page.keyboard.down("Control");
    await page.mouse.move(left, top);
    await page.mouse.down({ button: "right" });
    for (const [x, y] of [
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top + 4],
    ])
      await page.mouse.move(x, y, { steps: 6 });
    await page.waitForSelector("[data-lasso]");
    await page.mouse.up({ button: "right" });
    await page.keyboard.up("Control");
    await ui.run(["wait 2 tasks picked"]);
    assert.equal(await page.locator("[data-lasso]").count(), 0);
    assert.equal(await page.locator("[role=menuitemradio]").count(), 0, "no menu opened");
    const pickedIds = await page.evaluate(() => [...document.querySelectorAll("[data-selected=true]")].map((c) => c.dataset.task).sort());
    assert.deepEqual(pickedIds, [second, third].sort());

    // Right-clicking one of them offers to move them all.
    await page.click(`[data-task="${second}"]`, { button: "right" });
    await ui.run(["wait New pen… (2 picked)"]);
    await page.keyboard.press("Escape");
    await ui.run(["gone New pen… (2 picked)"]);

    // The bar puts them in a new pen.
    await page.click("[data-selection-bar] >> text=Pen");
    await ui.run(["click New pen… (2 picked)", "type Parked", "press Enter", "gone Create pen", "gone 2 tasks picked"]);
    await until(page, "Parked", [second, third].sort());

    // Ctrl + right-click on a card picks it, and again lets it go; Escape lets them all go.
    await page.keyboard.down("Control");
    await page.click(`[data-task="${first}"]`, { button: "right" });
    await ui.run(["wait 1 task picked"]);
    await page.click(`[data-task="${second}"]`, { button: "right" });
    await ui.run(["wait 2 tasks picked"]);
    await page.click(`[data-task="${first}"]`, { button: "right" });
    await ui.run(["wait 1 task picked"]);
    await page.keyboard.up("Control");
    await page.keyboard.press("Escape");
    await ui.run(["gone 1 task picked"]);

    // Picked, and put in the pen from the bar's menu with the others.
    await page.keyboard.down("Control");
    await page.click(`[data-task="${first}"]`, { button: "right" });
    await page.keyboard.up("Control");
    await page.click("[data-selection-bar] >> text=Pen");
    await ui.run(["click [role=menu] >> text=Pen: Parked", "gone 1 task picked"]);
    await until(page, "Parked", [first, second, third].sort());
  });
});
