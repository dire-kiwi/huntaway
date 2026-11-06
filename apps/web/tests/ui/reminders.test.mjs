import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const sidebar = (page) => page.locator("aside").innerText();
const taskNamed = async (title) => (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.title === title);

// IA-124: starring a task and setting reminders from its card's menu lists it in the sidebar; a
// reminder that has come round shows as due, and clearing it from the sidebar takes it out.
test("stars tasks and sets reminders, and lists them in the sidebar", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const card = "Try dragging this card to another column";
    const other = "A task waiting on an answer";
    await ui.run([`goto /p/${project.id}`, `wait ${card}`]);
    assert.doesNotMatch(await sidebar(page), /Starred|Reminders/, "no sections while nothing is starred or reminded");

    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred", "wait css=aside >> text=Try dragging"]);
    assert.equal((await taskNamed(card)).starred, true);

    await ui.run([`rclick ${other}`, "click [role=menu] >> text=Remind me in 3 hours", "wait css=aside >> text=Reminders", "wait css=aside >> text=in 3h"]);
    const at = Date.parse((await taskNamed(other)).remind_at);
    assert.ok(Math.abs(at - (Date.now() + 3 * 3600_000)) < 60_000, `reminder at ${new Date(at).toISOString()}`);

    // Come round (set by an agent, say, straight after): due, and counted on the section's heading.
    // The board's own save mustn't put the older time back when its response comes in late.
    const t = await taskNamed(other);
    await server.api("PATCH", `/tasks/${t.id}`, { remind_at: new Date(Date.now() - 60_000).toISOString(), reminder: "Answer it" });
    await ui.run(["wait css=aside >> text=due"]);
    assert.match(await sidebar(page), /Reminders\s+1\s/i);

    // Still there after a reload, and the panel shows the note.
    await ui.run([`goto /p/${project.id}`, "wait css=aside >> text=due", "click css=aside >> text=A task waiting", "click Details", "wait Answer it"]);

    await ui.run(["rclick css=aside >> text=A task waiting", "click [role=menu] >> text=Clear reminder", "gone css=aside >> text=Reminders"]);
    const cleared = await taskNamed(other);
    assert.equal(cleared.remind_at, null);
    assert.equal(cleared.reminder, null);

    await ui.run(["rclick css=aside >> text=Try dragging", "click [role=menu] >> text=Unstar", "gone css=aside >> text=Starred"]);
    assert.equal((await taskNamed(card)).starred, false);
  });
});

// A star whose save fails goes back, without undoing what changed on the server while it was saving.
test("a failed star puts back only the star", async () => {
  await withBrowser(server, { allowErrors: ["status of 503"] }, async (ui) => {
    const { page } = ui;
    const card = "Edit this task's title and description";
    const renamed = "Renamed while the star was saving";
    await ui.run([`goto /p/${project.id}`, `wait ${card}`]);
    const t = await taskNamed(card);
    // Holds the board's save until the other changes are in, then fails it.
    let release;
    const held = new Promise((r) => (release = r));
    await page.route("**/tasks/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await held;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"star failed"}' });
    });
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"]);
    await server.api("PATCH", `/tasks/${t.id}`, { title: renamed, remind_at: new Date(Date.now() - 60_000).toISOString() });
    await ui.run([`wait ${renamed}`, "wait css=aside >> text=due"]);
    release();
    await ui.run(["wait star failed", "gone css=aside >> text=Starred"]);
    await page.unrouteAll();
    const side = await sidebar(page);
    assert.match(side, /Reminders/i);
    assert.match(side, /Renamed while/);
    assert.ok(await page.getByText(renamed).first().isVisible());
    const saved = await taskNamed(renamed);
    assert.equal(saved.starred, false);
    // Left for the next test as it found it.
    await server.api("PATCH", `/tasks/${t.id}`, { title: card, remind_at: null });
  });
});

// Starred on the server while the board's own star was saving (by an agent, say): the failed
// save mustn't take the star off, though it's the same as the one that failed.
test("a failed star doesn't undo the same star saved meanwhile", async () => {
  await withBrowser(server, { allowErrors: ["status of 503"] }, async (ui) => {
    const { page } = ui;
    const card = "Something being worked on";
    const renamed = "Starred elsewhere meanwhile";
    await ui.run([`goto /p/${project.id}`, `wait ${card}`]);
    const t = await taskNamed(card);
    let release;
    const held = new Promise((r) => (release = r));
    await page.route("**/tasks/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await held;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"star failed"}' });
    });
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"]);
    await server.api("PATCH", `/tasks/${t.id}`, { title: renamed, starred: true });
    await ui.run([`wait ${renamed}`]);
    release();
    await ui.run(["wait star failed"]);
    await page.unrouteAll();
    assert.equal((await taskNamed(renamed)).starred, true);
    assert.match(await sidebar(page), /Starred[\s\S]*Starred elsewhere meanwhile/i);
    await server.api("PATCH", `/tasks/${t.id}`, { title: card, starred: false });
  });
});

// Star and then Unstar while the star is still saving, and both fail: unstarred, as the server
// has it, not the star the first one showed.
test("overlapping failed saves end up as the server has the task", async () => {
  await withBrowser(server, { allowErrors: ["status of 503"] }, async (ui) => {
    const { page } = ui;
    const card = "Merged and closed";
    await ui.run([`goto /p/${project.id}`, `wait ${card}`]);
    const held = [];
    await page.route("**/tasks/*", (route) => (route.request().method() === "PATCH" ? held.push(route) : route.continue()));
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Star", "wait css=aside >> text=Starred"]);
    await ui.run([`rclick ${card}`, "click [role=menu] >> text=Unstar", "gone css=aside >> text=Starred"]);
    for (const until = Date.now() + 5000; held.length < 2 && Date.now() < until; ) await page.waitForTimeout(20);
    assert.equal(held.length, 2);
    const fail = (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"save failed"}' });
    await fail(held[0]);
    await fail(held[1]);
    await ui.run(["wait save failed", "sleep 300"]);
    await page.unrouteAll();
    assert.equal((await taskNamed(card)).starred, false);
    assert.doesNotMatch(await sidebar(page), /Starred/i);
  });
});

// Snooze a reminder and then clear it while the snooze is still saving: the snooze fails, the
// clear (nulls for the time and the note) still stands, and then saves.
test("a failed snooze doesn't bring back a reminder cleared meanwhile", async () => {
  await withBrowser(server, { allowErrors: ["status of 503"] }, async (ui) => {
    const { page } = ui;
    const card = "An idea for later";
    const t = await taskNamed(card);
    await server.api("PATCH", `/tasks/${t.id}`, { remind_at: new Date(Date.now() + 86400_000).toISOString(), reminder: "Think it over" });
    await ui.run([`goto /p/${project.id}`, "wait css=aside >> text=An idea for later"]);
    const held = [];
    await page.route("**/tasks/*", (route) => (route.request().method() === "PATCH" ? held.push(route) : route.continue()));
    const row = "css=aside >> text=An idea for later";
    await ui.run([`rclick ${row}`, "click [role=menu] >> text=Remind me in 1 hour", "wait css=aside >> text=in 1h"]);
    await ui.run([`rclick ${row}`, "click [role=menu] >> text=Clear reminder", "gone css=aside >> text=Reminders"]);
    for (const until = Date.now() + 5000; held.length < 2 && Date.now() < until; ) await page.waitForTimeout(20);
    assert.equal(held.length, 2);
    await held[0].fulfill({ status: 503, contentType: "application/json", body: '{"error":"snooze failed"}' });
    await ui.run(["wait snooze failed", "sleep 300"]);
    assert.doesNotMatch(await sidebar(page), /Reminders/i, "the pending clear still shows");
    await held[1].continue();
    await page.unrouteAll();
    for (const until = Date.now() + 5000; (await taskNamed(card)).remind_at && Date.now() < until; ) await page.waitForTimeout(50);
    const saved = await taskNamed(card);
    assert.equal(saved.remind_at, null);
    assert.equal(saved.reminder, null);
    await ui.run(["sleep 300"]);
    assert.doesNotMatch(await sidebar(page), /Reminders/i);
  });
});
