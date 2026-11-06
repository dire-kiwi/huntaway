import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
beforeAll(() => {
  server = startServer();
});
afterAll(() => server?.stop());

// HA-122: a routine's run works in a thread of its own under the assistant, off every list the board loads, and posts
// its report (here, that it failed: agents can't run on this server) in the assistant's thread, which links to it.
test("a routine's report links to its thread, which opens though no list has it", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await server.api("GET", `/profiles/${profile.id}/assistant`);
  const routine = await server.api("POST", `/profiles/${profile.id}/automations`, {
    name: "Inbox",
    trigger: { kind: "cron", expr: "0 8 * * mon-fri" },
    action: { kind: "message_assistant", message: "Anything new?" },
  });
  const run = await server.api("POST", `/automations/${routine.id}/run`, {});
  assert.equal(run.status, "ok", JSON.stringify(run));
  const threadId = run.task_id;
  // Its agent fails to start; the run says so once it's ended.
  for (let i = 0; i < 100; i++) {
    const { runs } = await server.api("GET", `/automations/${routine.id}/runs`);
    if (runs[0].outcome) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { runs } = await server.api("GET", `/automations/${routine.id}/runs`);
  assert.equal(runs[0].outcome, "failed", JSON.stringify(runs[0]));

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait css=[data-testid=routine-report] >> text=failed"]);
    await page.locator("[data-testid=routine-report]").getByRole("button", { name: "A-2" }).click();
    await page.waitForURL(new RegExp(`/t/${threadId}$`));
    await ui.run(["wait Inbox ·", "wait Anything new?"]);
    // Loaded afresh, by its link: fetched, as no list has it, and it stays on its own page.
    await ui.run([`goto /t/${threadId}`, "wait Inbox ·"]);
    assert.equal(await page.getByText("Task not found.").count(), 0);
    assert.match(new URL(page.url()).pathname, new RegExp(`/t/${threadId}$`));
    // The assistant's Routines tab shows the run and how it went.
    await ui.run(["goto /assistant/Default", "click routines", "wait css=[data-testid=routine] >> text=Inbox", "wait css=[data-testid=routine] >> text=Failed"]);
    // Not on the profile's board.
    await ui.run(["goto /profile/Default", "wait Try a scratch task"]);
    assert.equal(await page.getByText("Inbox ·").count(), 0);
  });
});

// HA-234: an `at` routine whose time has passed (it ran, and turned itself off) can still be renamed and saved; only
// turning it on, or giving it a new time, needs one to come.
test("an at routine whose time has passed can be edited while it's off", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await server.api("GET", `/profiles/${profile.id}/assistant`);
  // To the second, as one made by an agent can be (the editor shows minutes).
  const at = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3600_000 + 17_000).toISOString();
  const routine = await server.api("POST", `/profiles/${profile.id}/automations`, {
    name: "Reminder",
    enabled: false,
    trigger: { kind: "at", at },
    action: { kind: "message_assistant", message: "Renew the domain" },
  });

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const dialog = page.getByRole("dialog");
    await ui.run(["goto /assistant/Default", "click routines", "click css=[data-testid=routine] >> text=Reminder", "wait Edit Reminder"]);
    await dialog.getByPlaceholder("Morning inbox check").fill("Domain reminder");
    await dialog.getByRole("button", { name: "Save routine" }).click();
    await ui.run(["gone Edit Reminder", "wait css=[data-testid=routine] >> text=Domain reminder"]);
    const renamed = await server.api("GET", `/automations/${routine.id}`);
    assert.equal(renamed.name, "Domain reminder");
    assert.equal(renamed.enabled, false);
    assert.deepEqual(renamed.trigger, { kind: "at", at }, "its time is kept to the second");

    // Turned on, it needs a time to come.
    await ui.run(["click css=[data-testid=routine] >> text=Domain reminder", "wait Edit Domain reminder"]);
    await dialog.getByRole("switch", { name: "On", exact: true }).click();
    await dialog.getByRole("button", { name: "Save routine" }).click();
    await ui.run(["wait Pick a time to come."]);
    assert.equal((await server.api("GET", `/automations/${routine.id}`)).enabled, false);
  });
});
