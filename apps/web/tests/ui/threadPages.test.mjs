import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/**
 * A long thread (IA-169): the agent starts a background subagent early on, which hasn't finished, then
 * writes 350 messages, each with a tool call: a page (100 of the main conversation's) is about 33 of them.
 */
function messages(taskId) {
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: taskId, kind, data, created_at: new Date(Date.UTC(2026, 9, 27, 7, 0, out.length)).toISOString() });
  const assistant = (content, parent = null) => add("claude", { type: "assistant", parent_tool_use_id: parent, message: { content } });
  add("user", { text: "Do a long job." });
  assistant([{ type: "tool_use", id: "A1", name: "Agent", input: { description: "Watch the logs", prompt: "Watch the logs as it goes.", run_in_background: true } }]);
  add("claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "A1", content: "Async agent launched successfully." }] }, tool_use_result: { isAsync: true } });
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
const noAnchoring = (page) => page.addInitScript(() => addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: "* { overflow-anchor: none !important; }" }))));

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

test("a long thread opens at its latest page and loads older ones as it's scrolled up, where it was", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await noAnchoring(page);
    const asked = await routeThread(page, task.id, messages(task.id));
    // Older pages wait to be let through.
    let release;
    await page.route(new RegExp(`/tasks/${task.id}/messages\\?before=`), async (route) => {
      await new Promise((r) => (release = r));
      await route.fallback();
    });
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "wait Load earlier messages"]);
    assert.ok(asked.length && asked.every((q) => q.includes("limit=") || q.startsWith("after=")), asked.join(" "));
    assert.equal(await page.getByText("Step 300 of the job.", { exact: true }).count(), 0);
    // The subagent started before the loaded messages is in the Agents list (stopped with the run).
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 done/);

    // At the top: the page before comes in above, and what was on screen stays put.
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Loading earlier messages"]);
    const shown = await topItem(page);
    release();
    await ui.run(["wait Step 300 of the job.", "sleep 300"]);
    const after = await itemAt(page, shown.text);
    assert.ok(Math.abs(after.y - shown.y) <= 2, `${JSON.stringify(shown)} → ${JSON.stringify(after)}`);
    assert.ok(asked.some((q) => q.startsWith("before=")), asked.join(" "));

    // All the way up to the start.
    await page.unroute(new RegExp(`/tasks/${task.id}/messages\\?before=`));
    for (let i = 0; i < 10 && (await page.getByText("Do a long job.", { exact: true }).count()) === 0; i++) {
      await scroller(page).evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(300);
    }
    await ui.run(["wait Do a long job.", "gone Load earlier messages", "wait Watch the logs"]);
  });
});

test("a subagent from before the loaded messages opens from the Agents list, and the thread comes back where it was", async () => {
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
    let fail = true;
    await page.route(new RegExp(`/tasks/${task.id}/messages\\?before=`), (route) => (fail ? route.fulfill({ status: 500, json: { error: "host is offline" } }) : route.fallback()));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Couldn't load earlier messages. Try again"]);
    fail = false;
    await ui.run(["click Couldn't load earlier messages. Try again", "wait Step 300 of the job."]);
  });
});

// IA-169 review: the subagent's view hid the row with the retry, and nothing loaded it again.
test("a failed page while loading back to a subagent can be tried again from its view", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, subagent offline" });
  await withBrowser(server, { allowErrors: [/500/] }, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages(task.id));
    let fail = true;
    await page.route(new RegExp(`/tasks/${task.id}/messages\\?before=`), (route) => (fail ? route.fulfill({ status: 500, json: { error: "host is offline" } }) : route.fallback()));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('Watch the logs')", "wait Show in thread"]);
    await ui.run(["wait Couldn't load earlier messages. Try again", "gone Watcher reading the logs."]);
    fail = false;
    await ui.run(["click Couldn't load earlier messages. Try again", "wait Watcher reading the logs.", "gone Load earlier messages", "gone Couldn't load earlier messages"]);
  });
});

// IA-169 review: a message stored while the thread's first page was loading had its event dropped, and was never
// loaded. Then the events kept for it were shown twice, when the page had them too.
for (const [name, inPage] of [["after the page is read", false], ["before the page is read", true]]) {
  test(`messages stored and changed while the first page loads are in the thread once: ${name}`, async () => {
    const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: `Long job, live ${inPage}` });
    const all = messages(task.id);
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      let socket;
      await page.routeWebSocket(/\/api\/ws/, (ws) => {
        socket = ws;
        ws.connectToServer();
      });
      // The first page is what the host read (`snapshot`), and comes after the events.
      let snapshot = null;
      let asked = false;
      let release;
      const held = new Promise((r) => (release = r));
      await routeThread(page, task.id, (q) => (q.has("limit") && !q.has("before") ? snapshot : all));
      await page.route(new RegExp(`/tasks/${task.id}/messages\\?limit=`), async (route) => {
        asked = true;
        await held;
        await route.fallback();
      });
      await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread"]);
      for (let i = 0; i < 50 && !asked; i++) await page.waitForTimeout(100);
      assert.ok(asked, "the first page was asked for");
      if (!inPage) snapshot = structuredClone(all);

      // A new message, and a change to one the page has.
      const message = { id: all.length + 1, task_id: task.id, kind: "claude", created_at: new Date().toISOString(), data: { type: "assistant", message: { content: [{ type: "text", text: "The answer, while it loaded." }] } } };
      all.push(message);
      const i = all.findIndex((m) => m.data?.message?.content?.[0]?.text === "Step 350 of the job.");
      all[i] = structuredClone(all[i]);
      all[i].data.message.content[0].text = "Step 350, revised.";
      if (inPage) snapshot = structuredClone(all);
      socket.send(JSON.stringify({ type: "delta", task_id: task.id, text: "Typing the answer" }));
      await ui.run(["wait Typing the answer"]);
      socket.send(JSON.stringify({ type: "message_updated", task_id: task.id, message: all[i] }));
      // The message's event clears the streamed text, so it's been handled.
      socket.send(JSON.stringify({ type: "message", task_id: task.id, message }));
      await ui.run(["gone Typing the answer"]);
      release();

      await ui.run(["wait Step 349 of the job.", "wait The answer, while it loaded.", "wait Step 350, revised.", "gone Step 350 of the job."]);
      const texts = await page.locator(".prose-chat").allInnerTexts();
      const at = (t) => texts.map((x, n) => (x.trim() === t ? n : -1)).filter((n) => n >= 0);
      assert.equal(at("The answer, while it loaded.").length, 1, texts.slice(-4).join(" | "));
      assert.equal(at("Step 350, revised.").length, 1, texts.slice(-4).join(" | "));
      assert.ok(at("Step 349 of the job.")[0] < at("Step 350, revised.")[0] && at("Step 350, revised.")[0] < at("The answer, while it loaded.")[0], texts.slice(-4).join(" | "));
    });
  });
}

// IA-169 review: a permission answered while the older page with it was loading stayed pending, as the page had it.
test("a permission answered while its page loads shows the answer", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, answered" });
  // A prompt in the page before the latest one.
  const all = messages(task.id);
  const at = all.findIndex((m) => m.data?.message?.content?.[0]?.text === "Step 300 of the job.");
  all.splice(at + 1, 0, { task_id: task.id, kind: "permission", created_at: all[at].created_at, data: { status: "pending", tool_use_id: "b300", tool_name: "Bash", input: { command: "echo 300" }, request_id: "p300" } });
  all.forEach((m, i) => (m.id = i + 1));
  const prompt = all[at + 1];
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    // The older page is what the host read (`snapshot`), and comes after the answer's event.
    let snapshot = null;
    let release;
    const held = new Promise((r) => (release = r));
    await routeThread(page, task.id, (q) => (q.has("before") && snapshot ? snapshot : all));
    await page.route(new RegExp(`/tasks/${task.id}/messages\\?before=`), async (route) => {
      snapshot ??= structuredClone(all);
      await held;
      await route.fallback();
    });
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job.", "sleep 300"]);
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Loading earlier messages"]);

    all[at + 1] = { ...prompt, data: { ...prompt.data, status: "allowed" } };
    socket.send(JSON.stringify({ type: "message_updated", task_id: task.id, message: all[at + 1] }));
    // Events are handled in order: once this one shows, so has the answer.
    const next = { id: all.length + 1, task_id: task.id, kind: "claude", created_at: new Date().toISOString(), data: { type: "assistant", message: { content: [{ type: "text", text: "Carrying on." }] } } };
    all.push(next);
    socket.send(JSON.stringify({ type: "message", task_id: task.id, message: next }));
    await ui.run(["wait Carrying on."]);
    release();

    await ui.run(["wait Step 300 of the job.", "wait Permission for Bash", "gone Claude wants to use Bash"]);
    // And when it's opened again.
    await ui.run(["click Close (Esc)", "gone Step 350 of the job.", `click css=[data-task='${task.id}']`, "click Thread", "wait Carrying on."]);
    await ui.run(["wait Permission for Bash", "gone Claude wants to use Bash"]);
  });
});

// IA-169 review: a reload after a reconnect that came while the thread was closed (but still kept) was dropped, and
// reopening it only asked for newer messages, so a permission answered while disconnected stayed pending.
test("a closed thread's reload after a reconnect has what it missed when it's opened again", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, reconnected" });
  const host = (await server.api("GET", "/hosts")).find((h) => h.local).id;
  const all = messages(task.id);
  const prompt = { id: all.length + 1, task_id: task.id, kind: "permission", created_at: new Date().toISOString(), data: { status: "pending", tool_use_id: "b350", tool_name: "Bash", input: { command: "echo 350" }, request_id: "p350" } };
  all.push(prompt);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    const asked = await routeThread(page, task.id, () => all);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Claude wants to use Bash", "click Close (Esc)", "gone Step 350 of the job."]);

    // Answered while disconnected; the reload after the reconnect comes while it's closed.
    all[all.length - 1] = { ...prompt, data: { ...prompt.data, status: "allowed" } };
    asked.length = 0;
    socket.send(JSON.stringify({ type: "resync", host_id: host }));
    for (let i = 0; i < 30 && !asked.some((q) => q.startsWith("after=")); i++) await page.waitForTimeout(100);
    assert.ok(asked.some((q) => q.startsWith("after=")), asked.join(" "));
    await page.waitForTimeout(300);

    await ui.run([`click css=[data-task='${task.id}']`, "click Thread", "wait Step 350 of the job.", "wait Permission for Bash", "gone Claude wants to use Bash"]);
  });
});

// IA-169 review: a page that added calls to a group of tool calls drew the group again, collapsed, and lost the place.
test("a page joining an expanded group of tool calls keeps it expanded, and the place", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, one group" });
  const out = [];
  const add = (kind, data) => out.push({ id: out.length + 1, task_id: task.id, kind, data, created_at: new Date(Date.UTC(2026, 9, 27, 8, 0, out.length)).toISOString() });
  add("user", { text: "Run them all." });
  for (let i = 1; i <= 200; i++) {
    add("claude", { type: "assistant", message: { content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: `command-${i}` } }] } });
    add("claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `output-${i}` }] } });
  }
  add("claude", { type: "assistant", message: { content: [{ type: "text", text: "All done." }] } });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await noAnchoring(page);
    await routeThread(page, task.id, out);
    let release;
    await page.route(new RegExp(`/tasks/${task.id}/messages\\?before=`), async (route) => {
      await new Promise((r) => (release = r));
      await route.fallback();
    });
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait All done.", "click css=button:has-text('earlier tool calls')", "gone css=button:has-text('earlier tool calls')"]);
    // A call opened, and the calls near it on screen.
    await ui.run(["click command-160", "wait output-160"]);
    const row = (text) =>
      scroller(page).evaluate((el, text) => {
        const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes(text));
        return r && Math.round(r.getBoundingClientRect().top - el.getBoundingClientRect().top);
      }, text);
    await scroller(page).evaluate((el) => {
      const r = [...el.querySelectorAll("[data-tool-row]")].find((x) => x.textContent.includes("command-160"));
      el.scrollTop += r.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
    });
    const before = await row("command-160");
    await scroller(page).evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await ui.run(["wait Loading earlier messages"]);
    release();
    await ui.run(["wait command-140", "sleep 300"]);
    assert.equal(await row("command-160"), before);
    await ui.run(["wait output-160", "gone css=button:has-text('earlier tool calls')"]);
  });
});

test("a thread opened again asks for its new messages, and after a resync for all it has loaded", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job, reopened" });
  const host = (await server.api("GET", "/hosts")).find((h) => h.local).id;
  const all = messages(task.id);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    const asked = await routeThread(page, task.id, () => all);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 350 of the job."]);
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await ui.run(["wait Step 300 of the job."]);
    const oldest = Number(asked.findLast((q) => q.startsWith("before=")).match(/before=(\d+)/)[1]);

    await ui.run(["click Close (Esc)", "gone Step 350 of the job."]);
    const add = (text) => all.push({ id: all.length + 1, task_id: task.id, kind: "claude", data: { type: "assistant", message: { content: [{ type: "text", text }] } }, created_at: new Date().toISOString() });
    add("Done while it was closed.");
    asked.length = 0;
    await ui.run([`click css=[data-task='${task.id}']`, "click Thread", "wait Done while it was closed.", "wait Step 300 of the job."]);
    assert.ok(asked.length && asked.every((q) => /^after=\d+$/.test(q) && Number(q.slice(6)) >= all.length - 1), asked.join(" "));

    // A resync (after a reconnect) loads everything from the oldest loaded message on again.
    add("Done while it was offline.");
    asked.length = 0;
    socket.send(JSON.stringify({ type: "resync", host_id: host }));
    await ui.run(["wait Done while it was offline."]);
    const from = Number(asked.find((q) => q.startsWith("after=")).match(/after=(\d+)/)[1]);
    assert.ok(from < oldest, `${asked} vs a page before ${oldest}`);
    await ui.run(["wait Step 300 of the job."]);
  });
});
