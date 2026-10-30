import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const PHONE = { size: "390x844", touch: true };
const TODO = "Edit this task's title and description";
const ATTENTION = "A task waiting on an answer";
const REVIEW = "Finished work to look over";

/** Whether the element with `text` is on screen (not in a column scrolled off to the side, say). */
const onScreen = (page, text) =>
  page.evaluate((text) => {
    const el = [...document.querySelectorAll("[data-task]")].find((e) => e.textContent.includes(text));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top < innerHeight;
  }, text);

// HA-13: on a phone the sidebar is a drawer, opened from the page's header and closed once it's taken you somewhere.
test("on a phone the sidebar is a drawer", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait role=tablist[name='Columns']"]);
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).isVisible(), false, "the sidebar starts closed");
    await ui.run(["click Menu", "wait role=button[name='Settings's]"]);
    // A press beside it closes it, and so does Escape.
    await page.mouse.click(370, 400);
    await ui.run(["gone role=button[name='Settings's]", "click Menu", "wait role=button[name='Settings's]", "press Escape", "gone role=button[name='Settings's]"]);
    // Going somewhere from it closes it.
    await ui.run(["click Menu", "click role=button[name='Settings's]", "wait role=heading[name='Settings']", "gone role=button[name='Analytics']"]);
    assert.equal(new URL(page.url()).pathname, "/settings");
    await ui.run(["click Menu", "click role=button[name='Analytics']", "wait role=heading[name='Analytics']"]);
  });
});

// HA-13: a phone's board shows one column at a time, picked from tabs above it or by swiping, and remembered.
test("on a phone the board shows one column at a time", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait role=tablist[name='Columns']"]);
    // Nothing picked yet: it opens on what needs attention.
    assert.match(await page.getByRole("tab", { selected: true }).textContent(), /^\W*Needs attention1$/);
    assert.ok(await onScreen(page, ATTENTION));
    assert.equal(await onScreen(page, TODO), false);

    await ui.run(["click role=tab[name=/^To do/]", "sleep 800"]);
    assert.ok(await onScreen(page, TODO));
    assert.equal(await onScreen(page, ATTENTION), false);

    // Swiping sideways picks the next column.
    await page.evaluate(() => {
      const el = document.querySelector("[role=tabpanel]").parentElement;
      el.scrollTo({ left: el.scrollLeft + el.clientWidth, behavior: "instant" });
    });
    await ui.run(["wait role=tab[name=/^In progress/][selected=true]"]);

    // The column picked last is the one shown next time.
    await ui.run([`goto /p/${project.id}`, "wait role=tab[name=/^In progress/][selected=true]", "sleep 300"]);
    assert.ok(await onScreen(page, "Something being worked on"));
  });
});

// HA-13: dragging doesn't work on a touch screen, so a card's menu button moves it to another column.
test("on a phone a card's menu moves it to another column", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click role=tab[name=/^To do/]", "sleep 600", `click [aria-label="Move ${TODO} to…"]`, "wait role=menu"]);
    assert.match(await page.getByRole("menu").textContent(), /^Move DEMO-2 to/);
    // Within the screen.
    const box = await page.getByRole("menu").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `menu at ${JSON.stringify(box)}`);
    await ui.run(["click role=menuitemradio[name='In review']", "gone role=menu", "wait role=tab[name=/^In review\\s*5$/]"]);
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    assert.equal(tasks.find((t) => t.title === TODO).status, "in_review");
    await ui.run(["click role=tab[name=/^In review/]", "sleep 600"]);
    assert.ok(await onScreen(page, TODO));
    assert.ok(await onScreen(page, REVIEW));
  });
});

// HA-13: a task opens over the whole of a phone's screen, with a back button to the board.
test("on a phone a task opens full screen with a back button", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click role=tab[name=/^Needs attention/]", "sleep 600", `click ${ATTENTION}`, "wait role=button[name='Back']"]);
    assert.ok(new URL(page.url()).searchParams.get("task"));
    const panel = await page.locator("main").first().boundingBox();
    assert.equal(Math.round(panel.width), 390);
    // No expand or close buttons: the back button closes it.
    assert.equal(await page.getByTitle("Expand").count(), 0);
    // On a touch screen Enter starts a new line, and the send button sends.
    await ui.run(["click Add extra instructions", "type first line", "press Enter", "type second line"]);
    assert.equal(await page.locator("textarea").inputValue(), "first line\nsecond line");
    await ui.run(["click role=button[name='Back']", "gone role=button[name='Back']", "wait role=tablist[name='Columns']"]);
    assert.equal(new URL(page.url()).searchParams.get("task"), null);
  });
});

// HA-13: dialogs fit a phone's screen.
test("on a phone the new task dialog fits the screen", async () => {
  await withBrowser(server, PHONE, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click role=button[name='New task']", "wait Create task"]);
    const box = await page.getByRole("dialog").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `dialog at ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  });
});

// HA-13: none of it on a desktop: the sidebar, the columns side by side, no menu buttons on cards, and the panel beside the board.
test("the desktop layout is as it was", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, `wait ${TODO}`]);
    assert.ok(await page.getByRole("button", { name: "Settings", exact: true }).isVisible());
    assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).count(), 0);
    assert.equal(await page.getByRole("tablist", { name: "Columns" }).count(), 0);
    assert.ok(await onScreen(page, TODO));
    assert.ok(await onScreen(page, ATTENTION));
    assert.equal(await page.locator(`[aria-label="Move ${TODO} to…"]`).isVisible(), false);
    await ui.run([`click ${ATTENTION}`, "wait role=button[name='Expand']"]);
    assert.equal(await page.getByRole("button", { name: "Back", exact: true }).count(), 0);
  });
});

// HA-13: a tablet keeps the desktop layout, but its cards have the menu button to move them, as dragging may not work.
test("a tablet has menu buttons on its cards, and a side panel wide enough to use", async () => {
  await withBrowser(server, { size: "820x1180", touch: true }, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, `wait ${TODO}`]);
    assert.equal(await page.getByRole("tablist", { name: "Columns" }).count(), 0);
    assert.ok(await page.locator(`[aria-label="Move ${TODO} to…"]`).isVisible());
    await ui.run([`click ${ATTENTION}`, "wait role=button[name='Expand']"]);
    const panel = await page.locator("main").first().boundingBox();
    assert.ok(panel.width >= 470, `panel ${panel.width} wide`);
  });
});
