// HA-218: a task's thread drawn from its items (with the host's Keep threads as items setting on) looks the same as
// drawn from its messages (with it off): the same task, its thread shot both ways, compared pixel for pixel. Its
// messages are served as a host serves them (routeThread), and its items as the server's translator makes them from
// those messages (server-ts/src/threads/translate.ts), as a window and pages of earlier items.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";
import { threadHistory } from "../fixtures/threadHistory.mjs";
import { convert } from "../../../server-ts/src/threads/translate.ts";
import { apply_events, initial_state, item_page, snapshot_window } from "../../src/threads.ts";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Far past the events the server writes for the task itself, which the view then leaves be. */
const SEQ = 100_000;

/** The thread `messages` make, as the thread API gives it. */
function snapshot(taskId, messages) {
  const c = convert(messages, { finished: false });
  const thread = { id: taskId, harness: "claude", status: "idle", created_at: "2026-10-26T07:00:00.000Z" };
  const s = apply_events(initial_state(thread), c.events.map((e, i) => ({ ...e, thread_id: taskId, seq: i + 1 })));
  return { ...s, seq: SEQ };
}

/** Serves `snap` as task `taskId`'s thread kept as items: windows, pages of earlier items, and no events after it. */
async function routeItems(page, taskId, snap) {
  const asked = [];
  await page.route(new RegExp(`/tasks/${taskId}/thread(/items|/events)?(\\?.*)?$`), (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams;
    asked.push(url.pathname.replace(/.*\/thread/, "thread") + url.search);
    if (url.pathname.endsWith("/items")) return route.fulfill({ json: item_page(snap, Number(q.get("before")), Number(q.get("limit") ?? 100)) });
    if (url.pathname.endsWith("/events")) return route.fulfill({ json: { events: [], more: false, seq: SEQ } });
    return route.fulfill({ json: q.has("limit") ? snapshot_window(snap, Number(q.get("limit"))) : snap });
  });
  return asked;
}

const setting = (on) => server.api("PATCH", "/settings", { thread_items: on });

async function idle(taskId) {
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    if (!(await server.api("GET", `/tasks/${taskId}`)).task.running) return;
  }
  assert.fail("the task's run didn't end");
}

/** The thread's rows as drawn, the composer left out. */
const shot = (page) => page.locator("[data-thread] [data-autoscroll]").screenshot({ animations: "disabled", caret: "hide" });

/**
 * The pixels of two shots that differ by more than a couple of levels in a channel (the anti-aliased edges of rounded
 * cards can come out a level apart from one draw to the next), and where they are; compared in the page's canvas.
 */
function differences(page, a, b) {
  const url = (png) => `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((ok, fail) => Object.assign(new Image(), { onload: (e) => ok(e.target), onerror: fail, src }));
    const pixels = (img) => {
      const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return { n: -1, size: [x.width, x.height, y.width, y.height] };
    const p = pixels(x), q = pixels(y);
    let n = 0, box = null;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) <= 2) continue;
      const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width);
      n++;
      box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
    }
    return { n, box };
  }, [url(a), url(b)]);
}

/** The two shots are the same picture; if not, both are saved for a look. */
async function same(page, a, b, what) {
  const d = await differences(page, a, b);
  if (d.n === 0) return;
  const base = join(tmpdir(), `item-thread-${process.pid}-${what.replace(/\W+/g, "-")}`);
  writeFileSync(`${base}-messages.png`, a);
  writeFileSync(`${base}-items.png`, b);
  assert.fail(`${what}: the thread drawn from items differs from it drawn from messages (${JSON.stringify(d)}; ${base}-{messages,items}.png)`);
}

test("a thread drawn from its items looks as it does drawn from its messages", async () => {
  // A task flagged as keeping its thread as items: its first message was written with the setting on.
  await setting(true);
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Items and messages" });
  await server.api("POST", `/tasks/${task.id}/messages`, { text: "Hello" });
  await idle(task.id);
  assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.thread_items, true);
  await setting(false);
  const messages = threadHistory(task.id);
  const snap = snapshot(task.id, messages);

  // Tall enough for the whole thread, and its expanded rows.
  await withBrowser(server, { size: "1900x4000" }, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages);
    const asked = await routeItems(page, task.id, snap);
    const look = async () => {
      await ui.run(["wait Merge it?", "wait Claude wants to use", "wait Conversation compacted", "wait Routine"]);
      const plain = await shot(page);
      // A subagent's row opened, a tool call's, the plan, and the turns' ends.
      await ui.run(["click Explore", "wait Subagent here.", "click Searched", "wait no match", "click Show the plan", "wait Do it."]);
      return [plain, await shot(page)];
    };

    // The setting off: the view on messages, as for every other task.
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait [data-thread=messages]"]);
    const fromMessages = await look();
    assert.deepEqual(asked, [], "no items asked for");

    // On: the same task's thread is drawn from its items. The view switches in place, keeping the rows opened, so it's
    // opened again to start as fresh as the view on messages did.
    await setting(true);
    await ui.run(["wait [data-thread=items]", `goto /p/${project.id}?task=${task.id}`, "click Thread", "wait [data-thread=items]"]);
    const fromItems = await look();
    assert.ok(asked.some((a) => a.startsWith("thread?limit=")), "a window of its items");
    await same(page, fromMessages[0], fromItems[0], "the thread");
    await same(page, fromMessages[1], fromItems[1], "with rows opened");

    // And its subagent's own thread (with its prompt, which is answered in the main conversation).
    await ui.run(["click Open subagent thread", "wait Show in thread", "wait Explore the config."]);
    const subFromItems = await shot(page);
    await setting(false);
    await ui.run(["wait [data-thread=messages]", "wait Show in thread", "wait Explore the config."]);
    await same(page, await shot(page), subFromItems, "a subagent's own thread");
  });
  await setting(false);
});

test("a long thread drawn from its items loads its earlier items as it's scrolled up", async () => {
  await setting(true);
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "A long one" });
  await server.api("POST", `/tasks/${task.id}/messages`, { text: "Hello" });
  await idle(task.id);
  // 400 replies: more than a window (300 items) and a page.
  const messages = [];
  for (let i = 0; i < 400; i++)
    messages.push({ id: i + 1, task_id: task.id, kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: `Reply ${i}` }] } }, created_at: "2026-10-26T07:00:00.000Z" });
  const snap = snapshot(task.id, messages);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const asked = await routeItems(page, task.id, snap);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait [data-thread=items]", "wait Reply 399", "gone Reply 50"]);
    assert.deepEqual(asked, ["thread?limit=300"]);
    // Scrolled to the top: the page before the window, and then the one before that.
    for (const text of ["Reply 50", "Reply 0"]) {
      await page.locator("[data-thread] [data-autoscroll]").evaluate((el) => (el.scrollTop = 0));
      await ui.run([`wait ${text}`]);
    }
    assert.deepEqual(asked, ["thread?limit=300", "thread/items?before=100&limit=200"]);
    await ui.run(["gone Load earlier messages"]);
  });
  await setting(false);
});

// HA-218 review: the view on messages and the view on items were different components, so a task switching from one to
// the other (its first message flags it, with the setting on) drew its thread again from scratch, composer and all:
// what was typed after sending went, and so did the focus.
test("a task's first message flags it, and the composer keeps its focus and what's typed after it", async () => {
  await setting(true);
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Flagged by its first message" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait [data-thread=messages]", "click css=textarea", "type First message", "press Enter"]);
    await ui.run(["type follow", "wait [data-thread=items]", "wait First message", "type up"]);
    assert.equal(await page.locator("textarea").inputValue(), "followup");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  });
  assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.thread_items, true);
  await setting(false);
});
