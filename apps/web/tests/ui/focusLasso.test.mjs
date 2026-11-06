import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

const nowIds = async () => (await server.api("GET", `/projects/${project.id}/tasks`)).filter((t) => t.now_at).map((t) => t.id).sort();
const boxOf = (page, id) =>
  page.evaluate((id) => {
    const r = document.querySelector(`[data-task="${id}"]`).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, id);

// HA-109: tasks start in Later; a card's menu moves it to Now, the board's switch shows Now, Later or all, and Ctrl + right-drag draws a lasso.
test("the menu and the lasso move tasks to Now and Later, and the switch shows them", async () => {
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  assert.ok(tasks.every((t) => !t.now_at));
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Merged and closed"]);
    const cardIds = await page.evaluate(() => [...document.querySelectorAll("[data-task]")].map((c) => c.dataset.task));
    assert.ok(cardIds.length >= 4);

    // The menu: one task to Now.
    // The first card is the one sent to Now by its menu; the lasso goes round two in the In review column, one above the other.
    const idOf = (title) => tasks.find((t) => t.title === title).id;
    const first = cardIds[0];
    const [second, third] = [idOf("Finished work to look over"), idOf("How a task moves across the board")];
    assert.ok(![second, third].includes(first));
    await page.click(`[data-task="${first}"]`, { button: "right" });
    await ui.run(["wait Move to Now", "click Move to Now"]);
    await page.waitForFunction((id) => !!document.querySelector(`[data-task="${id}"] [aria-label="Now"]`), first);
    assert.deepEqual(await nowIds(), [first]);

    // The switch: Now shows only that one, Later the rest, All everything; the choice stays over a reload.
    await ui.run(["click Only the tasks in Now"]);
    await page.waitForFunction(() => document.querySelectorAll("[data-task]").length === 1);
    await ui.run(["click Only the tasks in Later"]);
    await page.waitForFunction((n) => document.querySelectorAll("[data-task]").length === n - 1, cardIds.length);
    assert.equal(await page.locator(`[data-task="${first}"]`).count(), 0);
    await ui.run([`goto /p/${project.id}`]);
    await page.waitForFunction((n) => document.querySelectorAll("[data-task]").length === n - 1, cardIds.length);
    await ui.run(["click Every task"]);
    await page.waitForFunction((n) => document.querySelectorAll("[data-task]").length === n, cardIds.length);

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
    for (const [x, y] of [[right, top], [right, bottom], [left, bottom], [left, top + 4]]) await page.mouse.move(x, y, { steps: 6 });
    await page.waitForSelector("[data-lasso]");
    await page.mouse.up({ button: "right" });
    await page.keyboard.up("Control");
    await ui.run(["wait 2 tasks picked"]);
    assert.equal(await page.locator("[data-lasso]").count(), 0);
    assert.equal(await page.locator("[role=menuitemradio]").count(), 0, "no menu opened");
    const pickedIds = await page.evaluate(() => [...document.querySelectorAll("[data-selected=true]")].map((c) => c.dataset.task).sort());
    assert.deepEqual(pickedIds, [second, third].sort());

    // Right-clicking one of them moves them all.
    await page.click(`[data-task="${second}"]`, { button: "right" });
    await ui.run(["wait Move to Later (2 picked)"]);
    await page.keyboard.press("Escape");
    await ui.run(["gone Move to Later (2 picked)"]);

    // The bar sends them to Now.
    await page.click("[data-selection-bar] >> text=Now");
    await ui.run(["gone 2 tasks picked"]);
    for (let i = 0; i < 50 && (await nowIds()).length !== 3; i++) await page.waitForTimeout(100);
    assert.deepEqual(await nowIds(), [first, second, third].sort());

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

    // Picked and sent back to Later from the bar.
    await page.keyboard.down("Control");
    await page.click(`[data-task="${first}"]`, { button: "right" });
    await page.keyboard.up("Control");
    await page.click("[data-selection-bar] >> text=Later");
    for (let i = 0; i < 50 && (await nowIds()).length !== 2; i++) await page.waitForTimeout(100);
    assert.deepEqual(await nowIds(), [second, third].sort());
  });
});

// HA-109: the time a task stays in Now without activity is a setting of the host.
test("the host's settings say how long a task stays in Now", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /hosts/${(await server.api("GET", "/hosts"))[0].id}`, "wait Hours in Now without activity"]);
    const field = page.getByLabel("Hours in Now without activity");
    assert.equal(await field.inputValue(), "24");
    await field.fill("6");
    await field.blur();
    for (let i = 0; i < 50 && (await server.api("GET", "/settings")).now_expiry_hours !== 6; i++) await page.waitForTimeout(100);
    assert.equal((await server.api("GET", "/settings")).now_expiry_hours, 6);
  });
});
