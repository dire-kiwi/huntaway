import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

let server, project, sp, a, b;
beforeAll(async () => {
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
afterAll(() => server?.stop());

// Which of the subproject and its tasks are in pen `name`.
const penIds = async (name) => {
  const pens = await server.api("GET", `/profiles/${project.profile_id}/pens`);
  const pen = pens.find((p) => p.name === name);
  const ids = [];
  for (const t of [sp, a, b]) if (pen && (await server.api("GET", `/tasks/${t.id}`)).task.pen_id === pen.id) ids.push(t.id);
  return ids.sort();
};
const graphIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-task]")].map((c) => c.dataset.task).sort());
const ctrlRightClick = async (page, id) => {
  await page.keyboard.down("Control");
  await page.click(`[data-task="${id}"]`, { button: "right" });
  await page.keyboard.up("Control");
};

// HA-109 review, HA-285: the graph shows a subproject's tasks too, which can be picked on their own or with others, and
// put in a pen together.
test("the graph's subproject tasks can be picked and put in a pen", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Checkout rework", "click Graph view", "wait Child alpha", "wait Child beta"]);
    await ctrlRightClick(page, b.id);
    await ui.run(["wait 1 task picked"]);
    await ctrlRightClick(page, a.id);
    await ctrlRightClick(page, sp.id);
    await ui.run(["wait 3 tasks picked"]);
    await page.click("[data-selection-bar] >> text=Pen");
    await ui.run(["click New pen… (3 picked)", "type Checkout", "press Enter", "gone Create pen", "gone 3 tasks picked"]);
    for (let i = 0; i < 50 && (await penIds("Checkout")).length !== 3; i++) await page.waitForTimeout(100);
    assert.deepEqual(await penIds("Checkout"), [sp.id, a.id, b.id].sort());
  });
});

// HA-109 review: the status filter holds for a subproject's tasks in the graph too, whether or not their subproject shows.
test("the graph's subproject tasks follow the status filter", async () => {
  // A done task puts its subproject in review (its status follows its tasks'); the other task is still to do.
  await server.api("PATCH", `/tasks/${a.id}`, { status: "done" });
  assert.equal((await server.api("GET", `/tasks/${sp.id}`)).task.status, "in_review");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Checkout rework", "click Graph view", "wait Child alpha", "wait Child beta"]);
    const only = (id) =>
      page.waitForFunction((id) => document.querySelectorAll("[data-task]").length === 1 && !!document.querySelector(`[data-task="${id}"]`), id);
    const toggle = (status) => ui.run(["click Filter", `click css=[role=menuitemcheckbox] >> text=${status}`, "press Escape"]);
    // Done: the done task shows though its subproject (in review) doesn't, and the other, to do, is left out.
    await toggle("Done");
    await only(a.id);
    // In review instead: the subproject alone, as neither of its tasks is in review.
    await toggle("Done");
    await toggle("In review");
    await only(sp.id);
  });
});
