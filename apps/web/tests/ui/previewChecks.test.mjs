import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// HA-188: each card with a preview polls /api/preview-status, which waits up to 5s on a preview that doesn't answer. A
// browser opens 6 connections to a host, so a board with more such previews than that had every one of them busy, and
// opening a thread waited seconds for its messages. Only a couple of checks go at once now, and they all still get theirs.
test("preview checks leave the browser's connections for the rest of the board", async () => {
  const titles = Array.from({ length: 8 }, (_, i) => `Preview ${i}`);
  for (const title of titles) await server.api("POST", `/projects/${project.id}/tasks`, { title, status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.route(/\/projects\/[^/]+\/tasks\?kind=task$/, async (route) => {
      const res = await route.fetch();
      const tasks = await res.json();
      for (const t of tasks) if (titles.includes(t.title)) t.preview_url = `http://127.0.0.1:1/${t.title.replace(" ", "-")}`;
      await route.fulfill({ response: res, json: tasks });
    });
    let inflight = 0;
    let most = 0;
    const checked = new Set();
    await page.route(/\/api\/(h\/[^/]+\/)?preview-status\?/, async (route) => {
      checked.add(new URL(route.request().url()).searchParams.get("url"));
      most = Math.max(most, ++inflight);
      // A preview that doesn't answer, for a while.
      await new Promise((r) => setTimeout(r, 1000));
      inflight--;
      await route.fulfill({ json: { up: false, status: null } }).catch(() => {});
    });
    await ui.run([`goto /p/${project.id}`, ...titles.map((t) => `wait ${t}`)]);
    const deadline = Date.now() + 15_000;
    while (checked.size < titles.length && Date.now() < deadline) await page.waitForTimeout(100);
    assert.equal(checked.size, titles.length, `checked only ${[...checked].join(", ")}`);
    assert.ok(most <= 2, `${most} preview checks at once`);
  });
});
