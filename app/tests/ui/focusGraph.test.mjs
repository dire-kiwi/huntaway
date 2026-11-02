import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

let server, project, sp, a, b;
before(async () => {
  server = startServer();
  // Subprojects need worktrees, so a project on a git repository.
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  sp = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Checkout rework", task_type: "subproject" });
  a = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Child alpha", parent_id: sp.id });
  b = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Child beta", parent_id: sp.id });
});
after(() => server?.stop());

const nowIds = async () => {
  const all = [sp, a, b];
  const now = [];
  for (const t of all) if ((await server.api("GET", `/tasks/${t.id}`)).task.now_at) now.push(t.id);
  return now.sort();
};
const graphIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-task]")].map((c) => c.dataset.task).sort());
const ctrlRightClick = async (page, id) => {
  await page.keyboard.down("Control");
  await page.click(`[data-task="${id}"]`, { button: "right" });
  await page.keyboard.up("Control");
};

// HA-109 review: the graph shows a subproject's tasks too, and they follow the Now/Later choice on their own, not their subproject's.
test("the graph's subproject tasks follow Now and Later on their own, and can be picked and moved", async () => {
  await server.api("PATCH", `/tasks/${sp.id}`, { now: true });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Checkout rework", "click Graph view", "wait Child alpha", "click Only the tasks in Now"]);
    // The subproject is in Now and its tasks are in Later: they're left out.
    await page.waitForFunction(() => document.querySelectorAll("[data-task]").length === 1);
    assert.deepEqual(await graphIds(page), [sp.id]);

    // The other way round: its task in Now shows, beside the subproject (faded, not picked) it's in.
    await server.api("PATCH", `/tasks/${sp.id}`, { now: false });
    await server.api("PATCH", `/tasks/${a.id}`, { now: true });
    await page.waitForFunction((id) => document.querySelectorAll("[data-task]").length === 1 && !!document.querySelector(`[data-task="${id}"]`), a.id);
    assert.equal(await page.getByTitle(/not on this board/).count(), 1);
    await server.api("PATCH", `/tasks/${a.id}`, { now: false });

    // All: a subproject's task alone can be picked, and with others moved together.
    await ui.run(["click Every task", "wait Child beta"]);
    await ctrlRightClick(page, b.id);
    await ui.run(["wait 1 task picked"]);
    await ctrlRightClick(page, a.id);
    await ctrlRightClick(page, sp.id);
    await ui.run(["wait 3 tasks picked"]);
    await page.click("[data-selection-bar] >> text=Now");
    for (let i = 0; i < 50 && (await nowIds()).length !== 3; i++) await page.waitForTimeout(100);
    assert.deepEqual(await nowIds(), [sp.id, a.id, b.id].sort());
  });
});
