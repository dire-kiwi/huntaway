import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, routeThread, startServer, threadFeed, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// IA-168: a new item only builds and redraws what it changes (rows keep their objects, and pick what they show from
// the thread's model), and a thread nobody shows is dropped. What changes still has to show: a call's result that
// comes later, a prompt's answer, a subagent's items and status, and a thread opened again. The thread's events are
// the server's translator's for the messages a run would have stored (threadFeed), sent as `thread_event`s.
test("new and updated items show in the thread, and a closed thread isn't fetched again", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Thread updates", status: "in_review" });
  const feed = threadFeed(task.id);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      feed.socket = ws;
      ws.connectToServer();
    });
    await page.clock.install();
    const asked = await routeThread(page, task.id, feed);
    const windows = () => asked.filter((q) => q.startsWith("thread?")).length;
    const catchUps = () => asked.filter((q) => q.startsWith("thread/events")).length;
    const send = (data, kind = "claude") => feed.add({ kind, data });
    const assistant = (content, parent = null) => send({ type: "assistant", parent_tool_use_id: parent, message: { content } });
    const result = (useId, content, extra = {}, parent = null) =>
      send({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: useId, content, ...extra }] } });

    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait No agent has worked on this yet"]);
    assert.equal(windows(), 1);
    feed.socket.send(JSON.stringify({ type: "task", task: { ...task, running: true, thread_source: "items" } }));

    // A group of calls, whose results come after them.
    assistant([{ type: "text", text: "Looking around." }]);
    assistant([{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls first" } }]);
    assistant([{ type: "tool_use", id: "c2", name: "Bash", input: { command: "ls second" } }]);
    await ui.run(["wait ls second"]);
    assert.equal(await page.locator(".animate-spin.text-st-progress").count(), 2, "both calls are running");
    result("c1", "first output");
    result("c2", "no such dir", { is_error: true });
    await page.locator(".lucide-x.text-red-400").waitFor();
    assert.equal(await page.locator(".animate-spin.text-st-progress").count(), 0, "both calls have finished");
    await ui.run(["click ls second", "wait no such dir", "click ls first", "wait first output"]);

    // A prompt, then its answer.
    assistant([{ type: "tool_use", id: "c3", name: "Bash", input: { command: "rm -rf build" } }]);
    const prompt = send({ status: "pending", tool_use_id: "c3", tool_name: "Bash", input: { command: "rm -rf build" }, request_id: "p1" }, "permission");
    await ui.run(["wait Claude wants to use", "wait Always allow Bash"]);
    feed.update({ ...prompt, data: { ...prompt.data, status: "allowed" } });
    await ui.run(["gone Always allow Bash", "wait allowed"]);

    // A subagent: its row, its messages as they come, and its result.
    assistant([{ type: "tool_use", id: "A1", name: "Agent", input: { description: "Explore config", prompt: "Find the config." } }]);
    await ui.run(["wait Explore config", "click Explore config"]);
    assistant([{ type: "text", text: "Subagent's first finding." }], "A1");
    await ui.run(["wait Subagent's first finding"]);
    assistant([{ type: "text", text: "Subagent's second finding." }], "A1");
    await ui.run(["wait Subagent's second finding"]);
    // What came before is still there, and still open.
    await ui.run(["wait first output", "wait Subagent's first finding"]);
    result("A1", "Report: it's in config.rs");
    await page.locator(".lucide-check.text-emerald-400").first().waitFor();
    assistant([{ type: "text", text: "All done." }]);
    await ui.run(["wait All done"]);

    // Open, the thread catches up on a resync; closed for a while, it doesn't.
    const host = (await server.api("GET", "/hosts")).find((h) => h.local).id;
    assert.equal(catchUps(), 0);
    feed.socket.send(JSON.stringify({ type: "resync", host_id: host }));
    for (const end = Date.now() + 5000; catchUps() === 0 && Date.now() < end;) await page.waitForTimeout(50);
    assert.equal(catchUps(), 1, "an open thread catches up on a resync");
    await page.keyboard.press("Escape");
    await ui.run(["gone All done"]);
    await page.clock.fastForward(30_000);
    feed.socket.send(JSON.stringify({ type: "resync", host_id: host }));
    await page.waitForTimeout(1000);
    assert.equal(catchUps(), 1, "a closed thread doesn't catch up on a resync");

    // Opened again, its window is loaded again, with everything.
    await page.locator(`[data-task="${task.id}"]`).first().click();
    await ui.run(["wait All done", "wait Explore config"]);
    assert.equal(windows(), 2);
  });
});

// A subagent's items leave the main conversation's rows as they were, so its rows have to keep the thread at its end
// themselves: expanded in the main conversation, and in the subagent's own thread.
test("a thread at its end follows a subagent's items, inline and in its own thread", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Subagent follow", status: "in_review" });
  const feed = threadFeed(task.id);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      feed.socket = ws;
      ws.connectToServer();
    });
    await routeThread(page, task.id, feed);
    const assistant = (content, parent = null) => feed.add({ kind: "claude", data: { type: "assistant", parent_tool_use_id: parent, message: { content } } });
    const scroller = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector(".prose-chat"));
        return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
      });
    const scrollTo = (top) =>
      page.evaluate((top) => {
        const el = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector(".prose-chat"));
        el.scrollTop = top ?? el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      }, top);
    const findings = async (from, to) => {
      for (let i = from; i < to; i++) assistant([{ type: "text", text: `Finding ${i}\n\nwith a second paragraph\n\nand a third` }], "A1");
      await ui.run([`wait Finding ${to - 1}`]);
    };

    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait No agent has worked on this yet"]);
    feed.socket.send(JSON.stringify({ type: "task", task: { ...task, running: true, thread_source: "items" } }));
    for (let i = 0; i < 20; i++) assistant([{ type: "text", text: `Reply ${i}\n\nwith a second paragraph` }]);
    assistant([{ type: "tool_use", id: "A1", name: "Agent", input: { description: "Explore config", prompt: "Find the config." } }]);
    assistant([{ type: "text", text: "Finding start" }], "A1");
    await ui.run(["wait Explore config", "click Explore config", "wait Finding start"]);

    // Expanded in the main conversation.
    await scrollTo();
    await findings(0, 10);
    assert.ok((await scroller()).gap < 80, "a thread at its end follows an expanded subagent's messages");
    // Scrolled up, it stays where it is.
    await scrollTo(100);
    await findings(10, 15);
    assert.equal((await scroller()).top, 100, "a thread scrolled up isn't moved by a subagent's messages");

    // In the subagent's own thread (which opens at its end).
    await ui.run(["click [aria-label='Open subagent thread']", "wait Show in thread"]);
    await findings(15, 25);
    assert.ok((await scroller()).gap < 80, "a subagent's own thread at its end follows its messages");

    // A subagent whose prompt comes after it started (as Codex's can, with task_started): its own thread shows it above
    // its messages, and follows it.
    await page.keyboard.press("Escape");
    await ui.run(["gone Show in thread"]);
    assistant([{ type: "tool_use", id: "A2", name: "Agent", input: { description: "Late prompt" } }]);
    assistant([{ type: "text", text: "Second subagent here." }], "A2");
    await ui.run(["wait Late prompt", "click [aria-label='Open subagent thread'] >> nth=1", "wait Second subagent here", "wait Show in thread"]);
    await scrollTo();
    const prompt = Array.from({ length: 40 }, (_, i) => `Prompt line ${i}`).join("\n");
    feed.add({ kind: "claude", data: { type: "system", subtype: "task_started", tool_use_id: "A2", task_id: "k2", prompt } });
    await ui.run(["wait Prompt line 39"]);
    assert.ok((await scroller()).gap < 80, "a subagent's own thread at its end follows a prompt that comes late");
  });
});
