import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-168: a new message only builds and redraws what it changes (rows keep their objects, and pick what they show
// from the thread's model), and a thread nobody shows is dropped. What changes still has to show: a call's result
// that comes later, a prompt's answer, a subagent's messages and status, and a thread opened again.
test("new and updated messages show in the thread, and a closed thread isn't fetched again", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Thread updates", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    await page.clock.install();
    let fetches = 0;
    page.on("request", (r) => r.url().includes(`/tasks/${task.id}/messages`) && r.method() === "GET" && fetches++);
    let id = 5000;
    const send = (data, kind = "claude", type = "message", msgId = ++id) => {
      socket.send(JSON.stringify({ type, task_id: task.id, message: { id: msgId, task_id: task.id, kind, created_at: new Date().toISOString(), data } }));
      return msgId;
    };
    const assistant = (content, parent = null) => send({ type: "assistant", parent_tool_use_id: parent, message: { content } });
    const result = (useId, content, extra = {}, parent = null) =>
      send({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: useId, content, ...extra }] } });

    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait No agent has worked on this yet"]);
    socket.send(JSON.stringify({ type: "task", task: { ...task, running: true } }));

    // A group of calls, whose results come after them.
    assistant([{ type: "text", text: "Looking around." }]);
    assistant([{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls first" } }]);
    assistant([{ type: "tool_use", id: "c2", name: "Bash", input: { command: "ls second" } }]);
    await ui.run(["wait ls second"]);
    assert.equal(await page.locator(".animate-spin.text-st-progress").count(), 2, "both calls are running");
    result("c1", "first output");
    result("c2", "no such dir", { is_error: true });
    await page.locator(".lucide-x.text-danger").waitFor();
    assert.equal(await page.locator(".animate-spin.text-st-progress").count(), 0, "both calls have finished");
    await ui.run(["click ls second", "wait no such dir", "click ls first", "wait first output"]);

    // A prompt, then its answer.
    const prompt = { kind: "permission", status: "pending", tool_use_id: "c3", tool_name: "Bash", input: { command: "rm -rf build" }, request_id: "p1" };
    const promptId = send(prompt, "permission");
    await ui.run(["wait Claude wants to use", "wait Always allow Bash"]);
    send({ ...prompt, status: "allowed" }, "permission", "message_updated", promptId);
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
    await page.locator(".lucide-check.text-success").first().waitFor();
    assistant([{ type: "text", text: "All done." }]);
    await ui.run(["wait All done"]);

    // Open, the thread is fetched again on a resync; closed for a while, it isn't.
    const before = fetches;
    socket.send(JSON.stringify({ type: "resync" }));
    for (const end = Date.now() + 5000; fetches === before && Date.now() < end; ) await page.waitForTimeout(50);
    assert.equal(fetches, before + 1, "an open thread is fetched on a resync");
    await page.keyboard.press("Escape");
    await ui.run(["gone All done"]);
    await page.clock.fastForward(30_000);
    socket.send(JSON.stringify({ type: "resync" }));
    await page.waitForTimeout(1000);
    assert.equal(fetches, before + 1, "a closed thread isn't fetched on a resync");

    // Opened again, it's fetched again (the server has none of these messages, as they only came over the websocket).
    await page.locator(`[data-task="${task.id}"]`).first().click();
    await ui.run(["wait No agent has worked on this yet"]);
    assert.equal(fetches, before + 2);
  });
});

// A subagent's messages leave the main conversation's items as they were, so its rows have to keep the thread at its
// end themselves: expanded in the main conversation, and in the subagent's own thread.
test("a thread at its end follows a subagent's messages, inline and in its own thread", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Subagent follow", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    let id = 7000;
    const assistant = (content, parent = null) =>
      socket.send(JSON.stringify({ type: "message", task_id: task.id, message: { id: ++id, task_id: task.id, kind: "claude", created_at: new Date().toISOString(),
        data: { type: "assistant", parent_tool_use_id: parent, message: { content } } } }));
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
    socket.send(JSON.stringify({ type: "task", task: { ...task, running: true } }));
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
    socket.send(JSON.stringify({ type: "message", task_id: task.id, message: { id: ++id, task_id: task.id, kind: "claude", created_at: new Date().toISOString(),
      data: { type: "system", subtype: "task_started", tool_use_id: "A2", task_id: "k2", prompt } } }));
    await ui.run(["wait Prompt line 39"]);
    assert.ok((await scroller()).gap < 80, "a subagent's own thread at its end follows a prompt that comes late");
  });
});
