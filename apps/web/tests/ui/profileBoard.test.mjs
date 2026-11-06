import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(() => {
  server = startServer();
});
after(() => server?.stop());

// The counts in a profile's sidebar bar, by status.
const bar = (page, profile) =>
  page.evaluate((profile) => {
    const row = [...document.querySelectorAll("nav[aria-label=Profiles] button")].find((b) => b.textContent.includes(profile));
    return Object.fromEntries([...(row?.querySelectorAll("[data-status]") ?? [])].map((s) => [s.dataset.status, Number(s.textContent)]));
  }, profile);

// IA-120: each profile has a board of all its tasks, with a bar of counts in the sidebar, in place of the inbox.
test("a profile's board has its tasks from every project, and its bar leaves out empty columns", async () => {
  const work = await server.api("POST", "/profiles", { name: "work" });
  const site = await server.api("POST", `/profiles/${work.id}/projects`, { name: "Site", repo_path: `${server.dataDir}/site` });
  await server.api("POST", `/projects/${site.id}/tasks`, { title: "Ship the site", status: "ready_for_merge" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // An old inbox link lands on the first profile's board.
    await ui.run(["goto /inbox", "wait Try a scratch task", "wait Finished work to look over"]);
    assert.equal(new URL(page.url()).pathname, "/profile/Default");
    assert.equal(await page.getByText("Ship the site").count(), 0);
    assert.deepEqual(await bar(page, "Default"), { in_progress: 1, needs_attention: 1, in_review: 4 });
    assert.deepEqual(await bar(page, "work"), { ready_for_merge: 1 });

    await ui.run(["click css=nav[aria-label=Profiles] >> text=work", "wait Ship the site", "gone Try a scratch task"]);
    assert.equal(new URL(page.url()).pathname, "/profile/work");
  });
});

test("a scratch task made on a profile's board is in no project and opens beside it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "wait Try a scratch task", "click New task", "type /scratch", "press Space", "wait New scratch task in"]);
    // On a profile's board it starts out in no project (IA-129: `@` and a project's key can put it in one).
    assert.match(await page.locator("[aria-label='Reads as']").innerText(), /No project \(Default\)/);
    await ui.run(["type Find out what's slow", "press Control+Enter", "gone Reads as", "wait Find out what's slow"]);
    const [profile] = await server.api("GET", "/profiles");
    const made = (await server.api("GET", `/profiles/${profile.id}/tasks`)).find((t) => t.description === "Find out what's slow");
    assert.equal(made.project_id, null);
    assert.equal(made.task_type, "scratch");
    assert.equal(made.number, 2);

    await ui.run(["click S-2", "wait role=button[name=/^thread$/i]"]);
    assert.equal(new URL(page.url()).search, `?task=${made.id}`);
    // A scratch task has no changes, review or worktree.
    assert.equal(await page.locator("role=button[name=/^(changes|review)$/i]").count(), 0);
    // Its own page moves to the profile's board too.
    await ui.run([`goto /t/${made.id}`, "wait role=button[name=/^thread$/i]"]);
    await page.waitForURL(/\/profile\/Default\?task=/);
  });
});

// IA-120 review: a profile with no projects, on a host that can't run agents (so it can't take new scratch tasks), still
// shows every column its tasks are in.
test("a profile with no projects on a host that can't run agents shows all its columns", async () => {
  const lab = await server.api("POST", "/profiles", { name: "lab" });
  await server.api("POST", `/profiles/${lab.id}/tasks`, { title: "Old question", status: "in_review" });
  await server.api("POST", `/profiles/${lab.id}/tasks`, { title: "Old chat", status: "done" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await page.route("**/api/hosts", async (route) => {
      const res = await route.fetch();
      const hosts = (await res.json()).map((h) => ({ ...h, agents: false }));
      await route.fulfill({ response: res, json: hosts });
    });
    await ui.run(["goto /profile/lab", "wait Old question", "wait Old chat"]);
    assert.deepEqual(await bar(page, "lab"), { in_review: 1 });
    // It can't make a scratch task here, and has no project to make a task in.
    assert.equal(await page.locator("role=button[name=/New task/]").count(), 0);
  });
});
