import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

// HA-119: each profile has an assistant, which the sidebar opens full width and which is off the board.
test("the sidebar opens the profile's assistant, which stays off the board", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "wait Try a scratch task", "click css=nav[aria-label=Assistant] >> text=Assistant", "wait Message your assistant"]);
    assert.equal(new URL(page.url()).pathname, "/assistant/Default");
    // Opening it made it, as A-1 in no project, with a folder of its own.
    const assistant = await server.api("GET", `/profiles/${profile.id}/assistant`);
    assert.deepEqual([assistant.task_type, assistant.number, assistant.project_id, assistant.work_dir], ["assistant", 1, null, `assistants/${assistant.id}`]);
    await ui.run(["wait A-1"]);
    // A chat, not a task: no Start, no changes or review, no status to move it to.
    for (const name of [/^start$/i, /^(changes|review)$/i]) assert.equal(await page.getByRole("button", { name }).count(), 0, String(name));
    assert.equal(await page.getByText("Pull request", { exact: true }).count(), 0);

    // Not on the profile's board, or in its counts.
    await ui.run(["goto /profile/Default", "wait Try a scratch task"]);
    assert.equal(await page.getByText("A-1", { exact: true }).count(), 0);

    // Its own page, loaded afresh (the board's listings leave it out), moves to the assistant's page.
    await ui.run([`goto /t/${assistant.id}`, "wait Message your assistant"]);
    await page.waitForURL(/\/assistant\/Default$/);
  });
});

// HA-123: the assistant's approval rules are edited in its details, and its Actions tab lists what they asked about.
test("the assistant's rules can be changed, and a draft isn't saved until it's saved", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "wait 6 allow", "wait 14 ask", "wait 7 never", "wait (the defaults, for Google)"]);
    await ui.run(["click Edit rules", "wait Approval rules", "click Ask before the assistant creates a task on the board"]);
    // Trying a tool name says which rule decides it.
    await ui.run(["click css=[aria-label='A tool name to try the rules on']", "type mcp__huntaway__create_task", "wait (mcp__huntaway__create_task)"]);
    // Cancelled, nothing changes.
    await ui.run(["click Cancel", "gone Approval rules"]);
    assert.equal((await server.api("GET", `/profiles/${profile.id}/approval-rules`)).is_default, true);
    await ui.run(["click Edit rules", "wait Approval rules", "click Ask before the assistant creates a task on the board", "click Save rules", "gone Approval rules", "wait 15 ask"]);
    const saved = await server.api("GET", `/profiles/${profile.id}/approval-rules`);
    assert.equal(saved.is_default, false);
    assert.deepEqual(saved.rules.at(-1), { tool: "mcp__huntaway__create_task", decision: "ask" });
    // Back to the defaults, from the dialog.
    page.once("dialog", (d) => d.accept());
    await ui.run(["click Edit rules", "wait Approval rules", "click Defaults", "gone Approval rules", "wait (the defaults, for Google)"]);
    assert.equal((await server.api("GET", `/profiles/${profile.id}/approval-rules`)).is_default, true);
    await ui.run(["click actions", "wait Nothing yet"]);
  });
});

// HA-123 review: two rules for one tool aren't saved with one of them dropped; the dialog says so, and what's saved decides as
// its Try a tool showed.
test("the rules dialog won't save two rules for one tool, and what it saves decides as it showed", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /assistant/Default", "wait Message your assistant", "click Edit rules", "wait Approval rules"]);
    const rows = await page.locator("[aria-label='Rules'] input").count();
    // Bash: allow, then bash: never beneath it.
    for (const [tool, decision] of [["Bash", "allow"], ["bash", "never"]]) {
      await ui.run(["click Add a rule"]);
      const n = await page.locator("[aria-label='Rules'] input").count();
      await page.getByRole("textbox", { name: `Rule ${n}'s tool` }).fill(tool);
      await page.getByRole("combobox", { name: `Rule ${n}'s decision` }).selectOption(decision);
    }
    assert.equal(await page.locator("[aria-label='Rules'] input").count(), rows + 2);
    await ui.run(["click css=[aria-label='A tool name to try the rules on']", "type Bash", "wait never (bash)", "wait has more than one rule"]);
    assert.equal(await page.getByRole("button", { name: "Save rules" }).isDisabled(), true);
    assert.equal(await page.locator("[aria-label='Rules'] input[aria-invalid='true']").count(), 2);
    // The allow goes: saved, it's never, as shown.
    await ui.run([`click Remove rule ${rows + 1}`, "gone has more than one rule", "wait never (bash)", "click Save rules", "gone Approval rules"]);
    const saved = await server.api("GET", `/profiles/${profile.id}/approval-rules`);
    assert.deepEqual(saved.rules.filter((r) => r.tool.toLowerCase() === "bash"), [{ tool: "bash", decision: "never" }]);
    // Put back for the other tests.
    await server.api("POST", `/profiles/${profile.id}/approval-rules`, { reset: true });
  });
});
