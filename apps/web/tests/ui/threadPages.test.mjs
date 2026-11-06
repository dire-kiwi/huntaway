import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, routeThread, startServer, threadFeed, withBrowser } from "./harness.mjs";
import { item_page, snapshot_window } from "../../src/threads.ts";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

/**
 * A long thread (IA-169): the agent starts a background subagent early on, which hasn't finished, then writes 350
 * messages, each with a tool call: 703 items, so its window (the last 300 items) starts at Step 201, and a page (200
 * items) is 100 steps.
 */
function messages(taskId) {
  const out = [];
  const add = (kind, data) =>
    out.push({ id: out.length + 1, task_id: taskId, kind, data, created_at: new Date(Date.UTC(2026, 9, 27, 7, 0, out.length)).toISOString() });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, message: { content } });
  add("user", { text: "Do a long job." });
  assistant([
    { type: "tool_use", id: "A1", name: "Agent", input: { description: "Watch the logs", prompt: "Watch the logs as it goes.", run_in_background: true } },
  ]);
  add("claude", {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "A1", content: "Async agent launched successfully." }] },
    tool_use_result: { isAsync: true },
  });
  add("claude", { type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "A1", is_backgrounded: true, description: "Watch the logs" });
  assistant([{ type: "text", text: "Watcher reading the logs." }], "A1");
  for (let i = 1; i <= 350; i++) {
    assistant([{ type: "text", text: `Step ${i} of the job.` }]);
    assistant([{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `echo ${i}` } }]);
    add("claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `b${i}`, content: String(i) }] } });
  }
  add("claude", { type: "system", subtype: "task_progress", task_id: "k1", tool_use_id: "A1", description: "Tailing server.log" });
  return out;
}

/** Chromium keeps what's on screen in place by itself (CSS scroll anchoring); Safari doesn't, so the thread does it too. */
const noAnchoring = (page) =>
  page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () =>
      document.head.append(Object.assign(document.createElement("style"), { textContent: "* { overflow-anchor: none !important; }" })),
    ),
  );

const scroller = (page) => page.locator(".overflow-y-auto:has(.prose-chat)").first();

/** The thread's top item on screen, and how far it is from the top of the scrolled area. */
const topItem = (page) =>
  scroller(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const item = [...el.querySelector(":scope > div.mx-auto:not(.hidden)").children].find((c) => c.getBoundingClientRect().bottom > top);
    return { text: item.textContent, y: Math.round(item.getBoundingClientRect().top - top) };
  });

/** Where the item with this text is now, as topItem has it. */
const itemAt = (page, text) =>
  scroller(page).evaluate((el, text) => {
    const item = [...el.querySelector(":scope > div.mx-auto:not(.hidden)").children].find((c) => c.textContent === text);
    return { text, y: Math.round(item.getBoundingClientRect().top - el.getBoundingClientRect().top) };
  }, text);

/** Older pages (`/thread/items?before=`) wait for `release` to be let through. */
async function holdPages(page, taskId) {
  const gate = { release: null, asked: false };
  await page.route(new RegExp(`/tasks/${taskId}/thread/items\\?before=`), async (route) => {
    gate.asked = true;
    await new Promise((r) => (gate.release = r));
    await route.fallback();
  });
  return gate;
}

/** Pages of earlier items fail (a 500) while `fail.on`. */
async function failPages(page, taskId) {
  const fail = { on: true };
  await page.route(new RegExp(`/tasks/${taskId}/thread/items\\?before=`), (route) =>
    fail.on ? route.fulfill({ status: 500, json: { error: "host is offline" } }) : route.fallback(),
  );
  return fail;
}

/** Waits for `pred` to hold, for up to 3 seconds. */
async function until(page, pred, what) {
  for (let i = 0; i < 30 && !pred(); i++) await page.waitForTimeout(100);
  assert.ok(pred(), what);
}

const textOf = (feed, text) => feed.snapshot().items.find((i) => i.text === text);

test("a long thread opens at its latest window and loads older pages as it's scrolled up, where it was", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await noAnchoring(page);
    const asked = await routeThread(page, task.id, messages(task.id));
    const gate = await holdPages(page, task.id);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "wait Load earlier messages"]);
    assert.deepEqual(asked, ["thread?limit=300"]);
    assert.equal(await page.getByText("Step 200 of the job.", { exact: true }).count(), 0);
    // The subagent started before the window is in the Agents list (stopped with the run).
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 done/);

    // At the top: the page before comes in above, and what was on screen stays put.
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Loading earlier messages"]);
    const shown = await topItem(page);
    gate.release();
    await ui.run(["wait Step 200 of the job.", "sleep 300"]);
    const after = await itemAt(page, shown.text);
    assert.ok(Math.abs(after.y - shown.y) <= 2, `${JSON.stringify(shown)} → ${JSON.stringify(after)}`);
    assert.ok(asked.includes("thread/items?before=403&limit=200"), asked.join(" "));

    // All the way up to the start.
    await page.unroute(new RegExp(`/tasks/${task.id}/thread/items\\?before=`));
    for (let i = 0; i < 10 && (await page.getByText("Do a long job.", { exact: true }).count()) === 0; i++) {
      await scroller(page).evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(300);
    }
    await ui.run(["wait Do a long job.", "gone Load earlier messages", "wait Watch the logs"]);
  });
});

test("a subagent from before the window opens from the Agents list, and the thread comes back where it was", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, subagent" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await noAnchoring(page);
    await routeThread(page, task.id, messages(task.id));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 1500));
    await page.waitForTimeout(300);
    const shown = await topItem(page);

    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Watch the logs')", "wait Show in thread"]);
    // It loads back to the subagent's start, for what it did.
    await ui.run(["wait Watcher reading the logs.", "wait Watch the logs as it goes.", "gone Load earlier messages", "gone Step 350 of the job."]);

    await ui.run(["press Escape", "wait Step 350 of the job.", "gone Show in thread", "sleep 300"]);
    const back = await itemAt(page, shown.text);
    assert.ok(Math.abs(back.y - shown.y) <= 2, `${JSON.stringify(shown)} → ${JSON.stringify(back)}`);
  });
});

test("a failed page can be tried again", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, offline" });
  await withBrowser(server, { allowErrors: [/500/] }, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages(task.id));
    const fail = await failPages(page, task.id);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Couldn't load earlier messages. Try again"]);
    fail.on = false;
    await ui.run(["click Couldn't load earlier messages. Try again", "wait Step 200 of the job."]);
  });
});

// IA-169 review: the subagent's view hid the row with the retry, and nothing loaded it again.
test("a failed page while loading back to a subagent can be tried again from its view", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, subagent offline" });
  await withBrowser(server, { allowErrors: [/500/] }, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages(task.id));
    const fail = await failPages(page, task.id);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Watch the logs')", "wait Show in thread"]);
    await ui.run(["wait Couldn't load earlier messages. Try again", "gone Watcher reading the logs."]);
    fail.on = false;
    await ui.run([
      "click Couldn't load earlier messages. Try again",
      "wait Watcher reading the logs.",
      "gone Load earlier messages",
      "gone Couldn't load earlier messages",
    ]);
  });
});

/** A browser's websocket to the server, with the frames a test sends on it as the server's. */
async function socketOf(page) {
  const held = { socket: null };
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    held.socket = ws;
    ws.connectToServer();
  });
  return held;
}

// IA-169 review (on messages then): a message stored while the thread's first page was loading had its event dropped,
// and was never loaded; then the events kept for it were shown twice, when the page had them too. On items, the events
// that come while the window loads are held, and those after its seq applied once it has.
for (const [name, inWindow] of [
  ["after the window is read", false],
  ["before the window is read", true],
]) {
  test(`items added and changed while the window loads are in the thread once: ${name}`, async () => {
    const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: `Long job, live ${inWindow}` });
    const feed = threadFeed(task.id, messages(task.id));
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      const ws = await socketOf(page);
      // The window is what the host read (`snapshot`), and comes after the events.
      let snapshot = null;
      let asked = false;
      let release;
      const held = new Promise((r) => (release = r));
      await routeThread(page, task.id, feed);
      await page.route(new RegExp(`/tasks/${task.id}/thread\\?limit=`), async (route) => {
        asked = true;
        snapshot = feed.snapshot();
        await held;
        if (inWindow) snapshot = feed.snapshot();
        await route.fulfill({ json: snapshot_window(snapshot, 300) });
      });
      await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread"]);
      await until(page, () => asked, "the window was asked for");
      feed.socket = ws.socket;

      // A change to an item the window has, a new one, and streamed text for the one after.
      feed.event({ type: "item.updated", item_id: textOf(feed, "Step 350 of the job.").id, patch: { text: "Step 350, revised." } });
      feed.add({ kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: "The answer, while it loaded." }] } } });
      feed.delta("stream:next", 0, "Typing the next one");
      await ui.run(["wait Typing the next one"]);
      release();

      await ui.run(["wait Step 349 of the job.", "wait The answer, while it loaded.", "wait Step 350, revised.", "gone Step 350 of the job."]);
      const texts = await page.locator(".prose-chat").allInnerTexts();
      const at = (t) => texts.map((x, n) => (x.trim() === t ? n : -1)).filter((n) => n >= 0);
      assert.equal(at("The answer, while it loaded.").length, 1, texts.slice(-4).join(" | "));
      assert.equal(at("Step 350, revised.").length, 1, texts.slice(-4).join(" | "));
      assert.ok(
        at("Step 349 of the job.")[0] < at("Step 350, revised.")[0] && at("Step 350, revised.")[0] < at("The answer, while it loaded.")[0],
        texts.slice(-4).join(" | "),
      );
    });
  });
}

/** messages(), with a prompt (pending) for Step `n`'s call, after its call. */
function withPrompt(taskId, n) {
  const all = messages(taskId);
  const at = all.findIndex((m) => m.data?.message?.content?.[0]?.id === `b${n}`);
  all.splice(at + 1, 0, {
    task_id: taskId,
    kind: "permission",
    created_at: all[at].created_at,
    data: { status: "pending", tool_use_id: `b${n}`, tool_name: "Bash", input: { command: `echo ${n}` }, request_id: `p${n}` },
  });
  all.forEach((m, i) => (m.id = i + 1));
  return { all, prompt: all[at + 1] };
}

const answered = (prompt) => ({ ...prompt, data: { ...prompt.data, status: "allowed" } });

// IA-169 review: a permission answered while the older page with it was loading stayed pending, as the page had it.
test("a permission answered while its page loads shows the answer", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, answered" });
  // A prompt in the page before the window.
  const { all, prompt } = withPrompt(task.id, 150);
  const feed = threadFeed(task.id, all);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const ws = await socketOf(page);
    // The older page is what the host read (before the answer), and comes after the answer's event.
    await routeThread(page, task.id, feed);
    let release;
    const held = new Promise((r) => (release = r));
    await page.route(new RegExp(`/tasks/${task.id}/thread/items\\?before=`), async (route) => {
      const read = feed.snapshot();
      await held;
      const q = new URL(route.request().url()).searchParams;
      await route.fulfill({ json: item_page(read, Number(q.get("before")), Number(q.get("limit"))) });
    });
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    feed.socket = ws.socket;
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Loading earlier messages"]);

    // The page was read before the answer: what it serves is the thread as it was then.
    feed.update(answered(prompt));
    feed.add({ kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: "Carrying on." }] } } });
    await ui.run(["wait Carrying on."]);
    release();

    await ui.run(["wait Step 150 of the job.", "wait Permission for Bash", "gone Claude wants to use Bash"]);
    // And when it's opened again.
    await ui.run(["click Close (Esc)", "gone Step 350 of the job.", `click css=[data-task='${task.id}']`, "click Thread", "wait Carrying on."]);
    await ui.run(["wait Permission for Bash", "gone Claude wants to use Bash"]);
  });
});

// IA-169 review: a reload after a reconnect that came while the thread was closed (but still kept) was dropped, so a
// permission answered while disconnected stayed pending. On items, a resync catches the kept thread up from its seq.
test("a closed thread's catch-up after a reconnect has what it missed when it's opened again", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, reconnected" });
  const host = (await server.api("GET", "/hosts")).find((h) => h.local).id;
  const { all, prompt } = withPrompt(task.id, 350);
  const feed = threadFeed(task.id, all);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const ws = await socketOf(page);
    const asked = await routeThread(page, task.id, feed);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Claude wants to use Bash", "click Close (Esc)", "gone Step 350 of the job."]);

    // Answered while disconnected (its events missed); the catch-up after the reconnect comes while it's closed.
    const seq = feed.seq;
    feed.update(answered(prompt), true);
    asked.length = 0;
    ws.socket.send(JSON.stringify({ type: "resync", host_id: host }));
    await until(page, () => asked.includes(`thread/events?after=${seq}`), asked.join(" "));
    await page.waitForTimeout(300);

    await ui.run([
      `click css=[data-task='${task.id}']`,
      "click Thread",
      "wait Step 350 of the job.",
      "wait Permission for Bash",
      "gone Claude wants to use Bash",
    ]);
    assert.ok(!asked.some((q) => q.startsWith("thread?")), `kept, not loaded again: ${asked.join(" ")}`);
  });
});

// IA-169 review: a page that added calls to a group of tool calls drew the group again, collapsed, and lost the place.
test("a page joining an expanded group of tool calls keeps it expanded, and the place", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, one group" });
  const out = [];
  const add = (kind, data) =>
    out.push({ id: out.length + 1, task_id: task.id, kind, data, created_at: new Date(Date.UTC(2026, 9, 27, 8, 0, out.length)).toISOString() });
  add("user", { text: "Run them all." });
  // 402 items: the window (300) starts at command-102.
  for (let i = 1; i <= 400; i++) {
    add("claude", { type: "assistant", message: { content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: `command-${i}` } }] } });
    add("claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `output-${i}` }] } });
  }
  add("claude", { type: "assistant", message: { content: [{ type: "text", text: "All done." }] } });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await noAnchoring(page);
    await routeThread(page, task.id, out);
    const gate = await holdPages(page, task.id);
    await ui.run([
      `goto /p/${project.id}?task=${task.id}`,
      "click Thread",
      "wait All done.",
      "click css=button:has-text('earlier tool calls')",
      "gone css=button:has-text('earlier tool calls')",
    ]);
    // A call opened, and the calls near it on screen.
    await ui.run(["click command-110", "wait output-110"]);
    const row = (text) =>
      scroller(page).evaluate((el, text) => {
        const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes(text));
        return r && Math.round(r.getBoundingClientRect().top - el.getBoundingClientRect().top);
      }, text);
    await scroller(page).evaluate((el) => {
      const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes("command-110"));
      el.scrollTop += r.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
    });
    const before = await row("command-110");
    await scroller(page).evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await ui.run(["wait Loading earlier messages"]);
    gate.release();
    await ui.run(["wait command-90", "sleep 300"]);
    assert.equal(await row("command-110"), before);
    await ui.run(["wait output-110", "gone css=button:has-text('earlier tool calls')"]);
  });
});

// On messages, this was about which messages a thread opened again, and one after a resync, asked for. On items, a
// thread kept after it's closed follows its events meanwhile (so opening it again asks for nothing), and a resync
// catches it up from its seq.
test("a thread opened again has what came while it was closed, and a resync catches it up from its seq", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, reopened" });
  const host = (await server.api("GET", "/hosts")).find((h) => h.local).id;
  const feed = threadFeed(task.id, messages(task.id));
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const ws = await socketOf(page);
    const asked = await routeThread(page, task.id, feed);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job."]);
    feed.socket = ws.socket;
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Step 200 of the job."]);

    await ui.run(["click Close (Esc)", "gone Step 350 of the job."]);
    const say = (text, quiet) => feed.add({ kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text }] } } }, quiet);
    say("Done while it was closed.");
    asked.length = 0;
    await ui.run([`click css=[data-task='${task.id}']`, "click Thread", "wait Done while it was closed.", "wait Step 200 of the job."]);
    assert.deepEqual(asked, []);

    // A resync (after a reconnect) catches it up from its seq.
    const seq = feed.seq;
    say("Done while it was offline.", true);
    ws.socket.send(JSON.stringify({ type: "resync", host_id: host }));
    await ui.run(["wait Done while it was offline.", "wait Step 200 of the job."]);
    assert.deepEqual(asked, [`thread/events?after=${seq}`]);
  });
});

// HA-225 review: refreshProfileData's catch-up of the shown threads had ended up inside a comment, so after the events
// socket reconnected (a server restart, a network drop) an open thread missed what came while it was down, until its
// next event showed the gap. The socket itself goes and comes back here, not a resync event.
test("an open thread catches up from its seq when the events socket reconnects", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, socket dropped" });
  const feed = threadFeed(task.id, messages(task.id));
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const sockets = [];
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      sockets.push(ws);
      ws.connectToServer();
    });
    const asked = await routeThread(page, task.id, feed);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job."]);
    const before = sockets.length;
    feed.socket = null;
    const seq = feed.seq;
    await sockets.at(-1).close();
    // Said while the socket was down: no event reaches the page.
    feed.add({ kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text: "Done while it was disconnected." }] } } });
    asked.length = 0;
    // The page reconnects (at once when the browser says it's online, rather than after its backoff).
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await ui.run(["wait Done while it was disconnected."]);
    assert.ok(sockets.length > before, "it reconnected");
    assert.ok(asked.includes(`thread/events?after=${seq}`), JSON.stringify(asked));
  });
});
