import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const ARCHIVED = "Shipped last week";
// A kanban column, and the titles of its cards top to bottom.
const column = (page, label) => page.locator("section", { has: page.locator(`span:text-is("${label}")`) });
const titles = (page, label) => column(page, label).locator("[data-task] > div:nth-child(2)").allTextContents();
const tasks = async () => Object.fromEntries((await server.api("GET", `/projects/${project.id}/tasks`)).map((t) => [t.title, t]));

// IA-217: the search narrows both views (the list's archived tasks too), keeps to its board over a reload, and "/" and Escape work it.
test("the search narrows the board and the list, and stays with its board", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Something being worked on", "press /", "type dark mode", "wait Plan a dark mode", "gone Something being worked on"]);
    await ui.run(["wait 1 of 11 tasks", "gone 1 archived"]);
    // Searched by key, the archived task shows in the list view, and the Done column links to it.
    await ui.run(["click Clear the search", "wait Something being worked on", "press /", "type demo-8", "wait 1 archived", "gone Merged and closed"]);
    await ui.run(["click List view", "click css=#archived-tasks button", `wait ${ARCHIVED}`, "gone Merged and closed"]);
    // Kept over a reload on this board, but not on another one.
    await ui.run([`goto /p/${project.id}`, `wait ${ARCHIVED}`, "wait 1 of 11 tasks", "goto /profile/Default", "wait Something being worked on", "gone of 11 tasks"]);
    await ui.run([`goto /p/${project.id}`, `wait ${ARCHIVED}`, "click Search tasks", "press Escape", "wait Merged and closed", "gone 1 of 11 tasks"]);
    assert.equal(await page.getByLabel("Search tasks").inputValue(), "");
    await ui.run(["click Board view"]);
  });
});

// IA-217: statuses pick the columns, types and flags the cards; each filter shows in the bar below the header, to take off.
test("filters leave out columns and cards, and come off one by one", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Something being worked on", "click Filter", "click css=[role=menuitemcheckbox] >> text=In review"]);
    await ui.run(["click css=[role=menuitemcheckbox] >> text=Plan", "click css=[role=menuitemcheckbox] >> text=Diagram", "press Escape", "gone Has a reminder"]);
    await ui.run(["wait 2 of 11 tasks", "gone Something being worked on", "gone Show the backlog", "gone A release notes card", "wait Plan a dark mode"]);
    assert.deepEqual(await titles(page, "In review"), ["How a task moves across the board", "Plan a dark mode for the demo site"]);
    assert.equal(await page.locator("section").count(), 1);
    // Taking the status off brings the columns back, with only the plans and diagrams in them.
    await page.locator("span:has(> button[title='Remove this filter'])", { hasText: "In review" }).getByTitle("Remove this filter").click();
    await ui.run(["wait 2 of 11 tasks", "wait Show the backlog (0)", "gone Something being worked on"]);
    await ui.run(["click Clear all", "wait Something being worked on", "gone of 11 tasks"]);
  });
});

// IA-217: with a filter on, a task dropped below a column's last card goes after that card, not after the tasks filtered out.
test("a task dropped under a filtered column goes after its last card shown", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Something being worked on", "click Filter", "click css=[role=menuitemcheckbox] >> text=Code task"]);
    await ui.run(["click css=[role=menuitemcheckbox] >> text=Plan", "press Escape", "gone Has a reminder", "gone A release notes card"]);
    const review = column(page, "In review");
    await page.locator("[data-task]", { hasText: "Try dragging this card" }).dragTo(review, { targetPosition: { x: 100, y: 600 } });
    await review.locator("[data-task]", { hasText: "Try dragging this card" }).waitFor();
    await ui.run(["click Clear all", "wait A release notes card"]);
    assert.deepEqual(await titles(page, "In review"), [
      "Finished work to look over",
      "How a task moves across the board",
      "Plan a dark mode for the demo site",
      "Try dragging this card to another column",
      "A release notes card",
    ]);
    const t = await tasks();
    assert.equal(t["Try dragging this card to another column"].status, "in_review");
  });
});

// IA-217: sorted other than by hand, the columns are in that order, and a drop only moves a task to another column (at its end).
test("a sort orders the columns, and a drop then only changes the column", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Something being worked on", "click Sort", "click Title", "wait css=button[title^='Sorted by title']"]);
    const sorted = [
      "A release notes card",
      "Finished work to look over",
      "How a task moves across the board",
      "Plan a dark mode for the demo site",
      "Try dragging this card to another column",
    ];
    assert.deepEqual(await titles(page, "In review"), sorted);
    // Within its column, a drop changes nothing.
    const before = await tasks();
    await page.locator("[data-task]", { hasText: "Try dragging this card" }).dragTo(page.locator("[data-task]", { hasText: "A release notes card" }));
    await page.waitForTimeout(300);
    assert.deepEqual(await titles(page, "In review"), sorted);
    const after = await tasks();
    for (const title of sorted) assert.equal(after[title].position, before[title].position, title);
    // In another column it goes last, under the board's own order.
    await page.locator("[data-task]", { hasText: "A release notes card" }).dragTo(page.locator("[data-task]", { hasText: "Edit this task's title" }));
    await column(page, "To do").locator("[data-task]", { hasText: "A release notes card" }).waitFor();
    assert.deepEqual(await titles(page, "To do"), ["A release notes card", "Edit this task's title and description"]);
    const moved = await tasks();
    assert.equal(moved["A release notes card"].status, "todo");
    assert.ok(moved["A release notes card"].position > moved["Edit this task's title and description"].position);
    // The sort is kept, and back on Manual the column is in the board's order again.
    await ui.run([`goto /p/${project.id}`, "wait css=button[title^='Sorted by title']", "click Sort", "click Manual", "wait css=button[title^='Sort the board']"]);
    assert.deepEqual(await titles(page, "To do"), ["Edit this task's title and description", "A release notes card"]);
  });
});

// IA-217 review: the controls made a subproject's header (the fullest) overflow at the desktop app's 900px minimum, pushing New
// task off screen and the title to nothing. Narrow boards put them in a row of their own; wide ones keep them in the header.
test("a board's header keeps its title and buttons on screen at any width, with the search open", async () => {
  const sp = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Checkout rework", task_type: "subproject" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // The widest the controls get: the longest sort's name on the button, and the search focused.
    await ui.run([`goto /t/${sp.id}/board`, "wait Checkout rework", "click Sort", "click Latest activity", "wait css=button[title^='Sorted by latest']"]);
    for (const [w, h] of [[900, 700], [1000, 800], [1100, 800], [1280, 800], [1440, 900], [1900, 1000]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByLabel("Search tasks").focus();
      await page.waitForTimeout(250); // the search field's width transition
      const layout = await page.evaluate(() => {
        const header = document.querySelector("main header, header");
        const box = (el) => el && el.getBoundingClientRect();
        const buttons = [...header.querySelectorAll("button")].filter((b) => /New task|Thread|List view|Board view/.test(b.textContent + b.title));
        return {
          width: window.innerWidth,
          scroll: document.documentElement.scrollWidth,
          title: box(header.querySelector("h1")).width,
          right: Math.max(...buttons.map((b) => box(b).right)),
          search: box(document.querySelector("[aria-label='Search tasks']")).right,
          buttons: buttons.length,
        };
      });
      const at = `${w}px: ${JSON.stringify(layout)}`;
      assert.equal(layout.buttons, 4, at);
      assert.ok(layout.scroll <= layout.width, at);
      assert.ok(layout.right <= layout.width, at);
      assert.ok(layout.search <= layout.width, at);
      assert.ok(layout.title >= 100, at);
    }
    // The filter menu opens on screen in the row below the header too.
    await page.setViewportSize({ width: 900, height: 700 });
    await ui.run(["click Filter", "wait Has a reminder"]);
    const menu = await page.locator("[role=menu]").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 900, JSON.stringify(menu));
    await ui.run(["press Escape", "click Sort", "click Manual"]);
  });
});
