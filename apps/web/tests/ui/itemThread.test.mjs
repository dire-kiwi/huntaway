// HA-218: a long thread drawn from its items opens at a window of its last items, and loads the pages before it as it's
// scrolled up. Its items are served as a host serves them (the harness's routeThread), as the server's translator makes
// them from messages (apps/server/src/threads/translate.ts).
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

test("a long thread drawn from its items loads its earlier items as it's scrolled up", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "A long one" });
  // 400 replies: more than a window (300 items) and a page.
  const messages = [];
  for (let i = 0; i < 400; i++)
    messages.push({
      id: i + 1,
      task_id: task.id,
      kind: "claude",
      data: { type: "assistant", message: { content: [{ type: "text", text: `Reply ${i}` }] } },
      created_at: "2026-10-26T07:00:00.000Z",
    });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const asked = await routeThread(page, task.id, messages);
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
});
