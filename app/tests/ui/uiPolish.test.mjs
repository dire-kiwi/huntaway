import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, project, tasks;
before(async () => {
  server = startServer();
  project = await demoProject(server);
  tasks = await server.api("GET", `/projects/${project.id}/tasks`);
});
after(() => server?.stop());

const byTitle = (title) => tasks.find((t) => t.title.startsWith(title));
const dialogs = (page) => page.locator("[role=dialog]").count();

// HA-44: a dialog closed on a mousedown on its backdrop, so a drag out of a field, or a stray click, lost what was typed.
test("a click on a dialog's backdrop closes it only when nothing typed would be lost", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Try dragging this card", "click New task", "wait [role=dialog]"]);
    // Pressed in the field and let go over the backdrop: the press wasn't on the backdrop.
    const field = await page.locator("[role=dialog] textarea").first().boundingBox();
    await page.mouse.move(field.x + 10, field.y + 10);
    await page.mouse.down();
    await page.mouse.move(20, 500, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal(await dialogs(page), 1, "a drag out of the field keeps it");
    // Something typed: kept. Taken out again: nothing to lose.
    await page.locator("[role=dialog] textarea").first().click();
    await page.keyboard.type("Half a title");
    await page.mouse.click(20, 500);
    await page.waitForTimeout(200);
    assert.equal(await dialogs(page), 1, "a click on the backdrop keeps what was typed");
    await page.locator("[role=dialog] textarea").first().click();
    for (let i = 0; i < "Half a title".length; i++) await page.keyboard.press("Backspace");
    await page.mouse.click(20, 500);
    await ui.run(["gone [role=dialog]"]);
  });
});

test("toggles are switches to screen readers", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click New task", "wait [role=dialog]"]);
    const sw = ui.page.locator("[role=dialog] [role=switch]").first();
    const was = await sw.getAttribute("aria-checked");
    assert.ok(was === "true" || was === "false");
    await sw.click();
    assert.equal(await sw.getAttribute("aria-checked"), was === "true" ? "false" : "true");
  });
});

// HA-44: every load waited for /api/open-token before showing anything, and a board that doesn't hand it out logged a 404.
test("a board that doesn't hand out its token isn't asked for it again once known", async () => {
  await withBrowser(server, {}, async (ui) => {
    const asked = [];
    ui.page.on("request", (r) => r.url().endsWith("/api/open-token") && asked.push(r.url()));
    await ui.run([`goto /p/${project.id}`, "wait Try dragging this card"]);
    await ui.page.waitForTimeout(300);
    assert.equal(asked.length, 1, "asked once, to find out");
    asked.length = 0;
    await ui.run([`goto /p/${project.id}`, "wait Try dragging this card"]);
    await ui.page.waitForTimeout(300);
    assert.equal(asked.length, 0);
  });
});

// HA-44: on a phone, the task's Start button was at the end of a row of tabs that scrolls sideways, half off-screen.
test("a phone's task header keeps Start on screen", async () => {
  const todo = byTitle("Try dragging this card");
  await withBrowser(server, { size: "390x844", touch: true }, async (ui) => {
    // After the panel has slid in.
    await ui.run([`goto /p/${project.id}?task=${todo.id}`, "wait Thread", "sleep 800"]);
    const start = await ui.page.getByRole("button", { name: "Start", exact: true }).boundingBox();
    assert.ok(start && start.x >= 0 && start.x + start.width <= 390, `Start at ${JSON.stringify(start)}`);
  });
});

// HA-44: the Live view offered to reply to tasks in Backlog and Done, which have no agent at work.
test("the Live view has no reply box on a task in Backlog or Done", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click Live view", "wait An idea for later", "wait Merged and closed", "wait A task waiting on an answer"]);
    const replies = (title) => ui.page.locator('[class*="h-[340px]"]').filter({ hasText: title }).getByPlaceholder("Reply to the agent…").count();
    assert.equal(await replies("An idea for later"), 0);
    assert.equal(await replies("Merged and closed"), 0);
    assert.equal(await replies("A task waiting on an answer"), 1);
  });
});

/** A thread of `n` short replies, enough to scroll, its messages' ids after `from`. */
function longThread(taskId, from = 0, n = 80) {
  const out = [];
  const add = (kind, data) => out.push({ id: from + out.length + 1, task_id: taskId, kind, data, created_at: new Date(Date.UTC(2026, 9, 27, 7, 0, out.length)).toISOString() });
  add("user", { text: "Talk for a while." });
  for (let i = 1; i <= n; i++) add("claude", { type: "assistant", message: { content: [{ type: "text", text: `Line ${i} of ${taskId.slice(0, 4)}.` }] } });
  return out;
}

// HA-44: the thread wasn't keyed by task, so another task's thread could open where the last one was scrolled to.
test("another task's thread opens at its latest message, not where the last one was scrolled to", async () => {
  // Tasks an agent has worked on, which open on their thread.
  const a = byTitle("A task waiting on an answer");
  const b = byTitle("Finished work to look over");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, a.id, longThread(a.id));
    await routeThread(page, b.id, longThread(b.id, 1000));
    const scroller = () => page.locator(".overflow-y-auto:has(.prose-chat)").first();
    await ui.run([`goto /p/${project.id}?task=${a.id}`, `wait Line 80 of ${a.id.slice(0, 4)}.`]);
    await scroller().evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    // As a click on its card does (which is under the panel here).
    await page.evaluate((id) => {
      history.pushState(null, "", `${location.pathname}?task=${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, b.id);
    await ui.run([`wait Line 80 of ${b.id.slice(0, 4)}.`, "sleep 300"]);
    const fromEnd = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    assert.ok(fromEnd < 80, `${fromEnd}px from the end`);
  });
});
