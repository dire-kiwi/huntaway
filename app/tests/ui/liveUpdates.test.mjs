import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

// IA-167: the thread, the task view and the cards are memoized, and streamed text is drawn on its own, so a token or
// a task event redraws only what it changes. What they show still has to follow the events: the streamed text (and
// the thread scrolled to it, unless it was scrolled up), cards, times on cards, and a subproject's progress.
test("streamed text, task events and the clock still update the thread, cards and task view", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live: streaming", status: "in_review" });
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live: other", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    // Events the agents would send, from this end of the websocket.
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    await page.clock.install();
    const send = (ev) => socket.send(JSON.stringify(ev));
    const thread = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector(".prose-chat"));
        return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
      });
    const scrollThreadTo = (top) =>
      page.evaluate((top) => {
        const el = [...document.querySelectorAll(".overflow-y-auto")].find((e) => e.querySelector(".prose-chat"));
        el.scrollTop = top;
        el.dispatchEvent(new Event("scroll"));
      }, top);

    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait No agent has worked on this yet"]);
    // A thread long enough to scroll.
    for (let i = 0; i < 40; i++)
      send({ type: "message", task_id: task.id, message: { id: 1000 + i, task_id: task.id, kind: "claude", created_at: ago(600 - i),
        data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}\n\nwith a second paragraph` }] } } } });
    await ui.run(["wait Reply 39"]);

    // At its end, the thread follows the text as it streams in.
    send({ type: "delta", task_id: task.id, text: "Streaming **now**" });
    await ui.run(["wait Streaming now"]);
    for (let i = 0; i < 30; i++) send({ type: "delta", task_id: task.id, text: `\n\nstreamed ${i}` });
    await ui.run(["wait streamed 29"]);
    assert.ok((await thread()).gap < 80, "a thread at its end follows streamed text");

    // Scrolled up, it stays where it is.
    await scrollThreadTo(100);
    for (let i = 30; i < 45; i++) send({ type: "delta", task_id: task.id, text: `\n\nstreamed ${i}` });
    await ui.run(["wait streamed 44"]);
    assert.equal((await thread()).top, 100, "a thread scrolled up isn't moved by streamed text");

    // The saved message takes the streamed text's place.
    send({ type: "delta_reset", task_id: task.id });
    await ui.run(["gone Streaming now"]);

    // A task event redraws its card, and the open task's header.
    send({ type: "task", task: { ...task, title: "Live: renamed" } });
    await page.locator(`[data-task="${task.id}"]`).getByText("Live: renamed").waitFor();
    await page.locator("header").getByText("Live: renamed").first().waitFor();

    // Times on cards move on by themselves.
    const card = page.locator(`[data-task="${other.id}"]`);
    send({ type: "task", task: { ...other, last_activity_at: ago(30) } });
    await card.getByText("just now").waitFor();
    await page.clock.fastForward(125_000);
    await card.getByText("2m ago").waitFor();

    // A subproject's Board button counts its tasks as their events come in.
    send({ type: "task", task: { ...task, subproject: true } });
    const child = (n, status) => ({ ...other, id: `live-child-${n}`, number: 900 + n, title: `Live child ${n}`, parent_id: task.id, status });
    send({ type: "task", task: child(1, "todo") });
    send({ type: "task", task: child(2, "todo") });
    await page.locator("header button", { hasText: "0/2" }).waitFor();
    send({ type: "task", task: child(1, "done") });
    await page.locator("header button", { hasText: "1/2" }).waitFor();
  });
});
