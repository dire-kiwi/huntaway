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
