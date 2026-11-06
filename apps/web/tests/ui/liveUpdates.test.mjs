import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, routeThread, startServer, threadFeed, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

// IA-167: the thread, the task view and the cards are memoized, and streamed text is drawn on its own, so a token or
// a task event redraws only what it changes. What they show still has to follow the events: the streamed text (and
// the thread scrolled to it, unless it was scrolled up), cards, times on cards, and a subproject's progress.
test("streamed text, task events and the clock still update the thread, cards and task view", async () => {
  // A task whose thread is on items, as the events below say it is too.
  const task = { ...(await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live: streaming", status: "in_review" })), thread_source: "items" };
  const other = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live: other", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // Events the agents would send, from this end of the websocket: the thread's from the messages its run would have
    // stored, as the server's translator makes them (threadFeed).
    const feed = threadFeed(task.id);
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      feed.socket = ws;
      ws.connectToServer();
    });
    await routeThread(page, task.id, feed);
    await page.clock.install();
    const send = (ev) => feed.socket.send(JSON.stringify(ev));
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
      feed.add({
        kind: "claude",
        created_at: ago(600 - i),
        data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}\n\nwith a second paragraph` }] } },
      });
    await ui.run(["wait Reply 39"]);

    // At its end, the thread follows the text as it streams in. It's drawn as it comes (HA-39): as markdown again for
    // each token, a long reply took longer and longer; the saved message is markdown.
    let streamed = "";
    const delta = (text) => {
      feed.delta("stream:1", streamed.length, text);
      streamed += text;
    };
    delta("Streaming **now**");
    await ui.run(["wait Streaming **now**"]);
    for (let i = 0; i < 30; i++) delta(`\n\nstreamed ${i}`);
    await ui.run(["wait streamed 29"]);
    assert.ok((await thread()).gap < 80, "a thread at its end follows streamed text");

    // Scrolled up, it stays where it is.
    await scrollThreadTo(100);
    for (let i = 30; i < 45; i++) delta(`\n\nstreamed ${i}`);
    await ui.run(["wait streamed 44"]);
    assert.equal((await thread()).top, 100, "a thread scrolled up isn't moved by streamed text");

    // The saved message takes the streamed text's place (drawn as markdown).
    feed.add({ kind: "claude", data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: streamed }] } } });
    await ui.run(["gone Streaming **now**", "wait streamed 44"]);

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

    // The open task's card is marked, and only its: each card follows whether it's the one open (HA-39).
    const marked = (id) =>
      page.waitForFunction((id) => [...document.querySelectorAll("[data-task][aria-current]")].map((e) => e.dataset.task).join() === id, id, { timeout: 5000 });
    await marked(task.id);
    // (The panel covers the other card: open it as its card would.)
    await page.evaluate((id) => {
      history.pushState(null, "", `${location.pathname}?task=${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, other.id);
    await marked(other.id);
  });
});
