import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const CARD = "Try dragging this card to another column";

/** A thread long enough to scroll. */
function messages(taskId) {
  return Array.from({ length: 80 }, (_, i) => ({
    id: i + 1,
    task_id: taskId,
    kind: "claude",
    data: { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: `Step ${i + 1} of the job.` }] } },
    created_at: new Date(Date.UTC(2026, 9, 27, 7, 0, i)).toISOString(),
  }));
}

/** Two frames, for scroll events (sent with the next frame) to be handled. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// HA-32 kept a menu open while the thread follows its agent (data-autoscroll). HA-49: but not one on something that scrolls
// with the thread, which would be left behind.
test("a context menu stays open while the thread scrolls, unless it's on something the scroll moves", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Long job" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages(task.id));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Step 80 of the job.", `rclick ${CARD}`, "wait [role=menu]"]);
    const thread = page.locator("[data-autoscroll]");
    assert.ok(await thread.evaluate((el) => el.scrollHeight > el.clientHeight + 200), "the thread scrolls");

    // The thread following its agent, as follow() does.
    for (const to of [0, 1e6]) {
      await thread.evaluate((el, to) => (el.scrollTop = to), to);
      await frames(page);
      assert.equal(await page.locator("[role=menu]").count(), 1, `menu closed by the thread scrolling to ${to}`);
    }
    // And the user scrolling it by hand.
    await thread.hover();
    await page.mouse.wheel(0, -600);
    await frames(page);
    assert.equal(await page.locator("[role=menu]").count(), 1, "menu closed by a wheel over the thread");
    await ui.run(["press Escape", "gone [role=menu]"]);

    // A menu on something inside a scroller marked data-autoscroll (the board's column here: the thread has no menus
    // of its own yet) closes when that scrolls.
    const column = page.locator(`section:has-text("${CARD}") .overflow-y-auto`).first();
    await column.evaluate((el) => el.setAttribute("data-autoscroll", ""));
    await ui.run([`rclick ${CARD}`, "wait [role=menu]"]);
    await column.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await ui.run(["gone [role=menu]"]);
  });
});
