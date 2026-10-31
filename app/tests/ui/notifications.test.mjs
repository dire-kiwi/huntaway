import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Keeps the notifications a page shows in `window.notes`, with the object for clicking one. */
function recordNotifications() {
  const Real = window.Notification;
  window.notes = [];
  window.Notification = class extends Real {
    constructor(title, opts) {
      super(title, opts);
      window.notes.push({ title, body: opts?.body, silent: opts?.silent, n: this });
    }
  };
}

const notes = (page) => page.evaluate(() => window.notes.map((n) => `${n.title} | ${n.body}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HA-8: a task that goes to Needs attention (or is ready to review) notifies from one tab, and clicking it opens the
// task; tasks waiting already when the page loads, the task open in a focused window, the user's own moves and a run
// they stopped don't. The tab title and icon count the tasks that need attention.
test("tasks that need you notify once, with their key, title and reason, and the count is in the title", async () => {
  const create = (title, status) => server.api("POST", `/projects/${project.id}/tasks`, { title, status });
  await create("Notify: waiting already", "needs_attention");
  const live = await create("Notify: live", "in_progress");
  const stopped = await create("Notify: stopped", "in_progress");
  const shared = await create("Notify: two tabs", "in_progress");
  const moved = await create("Notify: moved here", "in_review");
  const waiting = async () => (await server.api("GET", `/projects/${project.id}/tasks`)).filter((t) => t.status === "needs_attention").length;
  const key = (t) => `${project.key}-${t.number}`;

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const context = page.context();
    await context.grantPermissions(["notifications"], { origin: server.url });
    await context.addInitScript(recordNotifications);
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    const send = (task) => socket.send(JSON.stringify({ type: "task", task }));

    // Picking notifications, with the permission granted already.
    await ui.run(["goto /settings", "click role=radio[name='Notifications']", "wait This browser shows the board's notifications"]);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ia.notifications"))).mode, "notify");

    // Tasks waiting already don't notify when the board loads, but they're counted.
    await ui.run([`goto /p/${project.id}`, "wait Notify: waiting already"]);
    const n = await waiting();
    await page.waitForFunction((n) => document.title === `(${n}) Huntaway`, n);
    assert.match(await page.evaluate(() => document.querySelector('link[rel="icon"]').href), /^data:image\/png/);
    await sleep(500);
    assert.deepEqual(await notes(page), []);

    // A question while the agent works.
    send({ ...live, status: "needs_attention", attention_reason: "Approve Bash?" });
    await page.waitForFunction(() => window.notes.length === 1);
    assert.deepEqual(await notes(page), [`${key(live)} Notify: live | Needs attention: Approve Bash?`]);
    assert.equal(await page.evaluate(() => window.notes[0].silent), true, "the sound is a setting of its own");
    await page.waitForFunction((n) => document.title === `(${n}) Huntaway`, n + 1);

    // Clicking it opens the task.
    await page.evaluate(() => window.notes[0].n.dispatchEvent(new Event("click")));
    await page.waitForURL(new RegExp(`\\?task=${live.id}`));
    await ui.run(["wait Approve Bash?"]);

    // Open in this (focused) window, it doesn't notify again.
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    send({ ...live, status: "in_progress", attention_reason: null });
    send({ ...live, status: "needs_attention", attention_reason: "Approve Edit?" });
    // Nor does a run the user stopped.
    send({ ...stopped, status: "needs_attention", attention_reason: "Stopped by user", running: false });
    await sleep(500);
    assert.equal((await notes(page)).length, 1);

    // Ready to review, once it has stayed so for a moment.
    send({ ...stopped, status: "in_review", running: false, attention_reason: null });
    await sleep(1000);
    assert.equal((await notes(page)).length, 1);
    await page.waitForFunction(() => window.notes.length === 2, null, { timeout: 8000 });
    assert.equal((await notes(page))[1], `${key(stopped)} Notify: stopped | Ready to review`);

    // Reloaded with tasks waiting: no burst.
    await page.reload();
    await ui.run(["wait Notify: waiting already"]);
    await sleep(1000);
    assert.deepEqual(await notes(page), []);

    // With two tabs, one of them notifies.
    const other = await context.newPage();
    await other.goto(`${server.url}/p/${project.id}`);
    await other.getByText("Notify: two tabs").first().waitFor();
    await server.api("PATCH", `/tasks/${shared.id}`, { status: "needs_attention" });
    await page.waitForFunction(() => window.notes.length === 1);
    await sleep(500);
    assert.deepEqual([...(await notes(page)), ...(await notes(other))], [`${key(shared)} Notify: two tabs | Needs attention`]);
    await other.waitForFunction((n) => document.title === `(${n}) Huntaway`, await waiting());

    // A move made in the other tab doesn't tell this one, which notifies (with Done turned on).
    await other.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("ia.notifications"));
      localStorage.setItem("ia.notifications", JSON.stringify({ ...s, events: { ...s.events, done: true } }));
    });
    await other.locator(`[data-task="${moved.id}"]`).click({ button: "right" });
    await other.getByText("Complete", { exact: false }).first().waitFor();
    await other.getByRole("menuitemradio", { name: "Done" }).or(other.getByRole("menuitem", { name: "Done" })).first().click();
    await sleep(1000);
    assert.equal((await server.api("GET", `/tasks/${moved.id}`)).task.status, "done");
    assert.equal((await notes(page)).length + (await notes(other)).length, 1);
    // Someone else's move does.
    await server.api("PATCH", `/tasks/${shared.id}`, { status: "done" });
    await page.waitForFunction(() => window.notes.length === 2);
    assert.equal((await notes(page))[1], `${key(shared)} Notify: two tabs | Done`);
    await other.close();
  });
});

test("without Web Locks, one of the tabs still notifies", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Notify: no locks", status: "in_progress" });
  await withBrowser(server, {}, async (ui) => {
    const context = ui.page.context();
    await context.grantPermissions(["notifications"], { origin: server.url });
    await context.addInitScript(recordNotifications);
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined });
      localStorage.setItem("ia.notifications", JSON.stringify({ mode: "notify" }));
    });
    const pages = [ui.page, await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.goto(`${server.url}/p/${project.id}`);
      await page.getByText("Notify: no locks").first().waitFor();
    }
    await server.api("PATCH", `/tasks/${task.id}`, { status: "needs_attention" });
    await pages[0].waitForFunction(() => document.title.startsWith("("));
    await sleep(1000);
    const all = (await Promise.all(pages.map(notes))).flat();
    assert.deepEqual(all, [`${project.key}-${task.number} Notify: no locks | Needs attention`]);
  });
});

test("Settings says why notifications can't work on a page that isn't secure", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // As on a plain-HTTP LAN address.
    await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
    await ui.run(["goto /settings", "click role=radio[name='Both']", "wait Notifications can't work here", "wait The sound plays once"]);
    assert.equal(await page.getByRole("button", { name: "Enable" }).count(), 0);
  });
});

// HA-26: a PR preview (a board that hands out its token) shows no system notifications, though they're allowed and
// picked; the count still shows.
test("a PR preview doesn't show system notifications", async () => {
  const preview = startServer("--open-token");
  try {
    const demo = await demoProject(preview);
    const task = await preview.api("POST", `/projects/${demo.id}/tasks`, { title: "Notify: preview", status: "in_progress" });
    await withBrowser(preview, {}, async (ui) => {
      const context = ui.page.context();
      await context.grantPermissions(["notifications"], { origin: preview.url });
      await context.addInitScript(recordNotifications);
      await context.addInitScript(() => localStorage.setItem("ia.notifications", JSON.stringify({ mode: "notify" })));
      await ui.run([`goto /p/${demo.id}`, "wait Notify: preview"]);
      await preview.api("PATCH", `/tasks/${task.id}`, { status: "needs_attention" });
      const n = (await preview.api("GET", `/projects/${demo.id}/tasks`)).filter((t) => t.status === "needs_attention").length;
      await ui.page.waitForFunction((n) => document.title === `(${n}) Huntaway`, n);
      await sleep(1000);
      assert.deepEqual(await notes(ui.page), []);
      await ui.run(["goto /settings", "wait It doesn't show system notifications"]);
      assert.equal(await ui.page.getByRole("button", { name: "Enable" }).count(), 0);
    });
  } finally {
    preview.stop();
  }
});
