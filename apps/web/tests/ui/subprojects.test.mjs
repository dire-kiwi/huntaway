import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

let server;
let project;
before(async () => {
  server = startServer();
  // Subprojects need worktrees, so a project on a git repository.
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
});
after(() => server?.stop());

// IA-129: a subproject is a task like any other, so its card opens it beside the board; its own board is a button away.
test("a subproject's card opens it beside the board, and its Board button opens its board", async () => {
  const sp = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Checkout rework", task_type: "subproject" });
  assert.equal(sp.subproject, true);
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Checkout rework", "click Checkout rework", "wait role=button[name=/^thread$/i]"]);
    assert.equal(new URL(page.url()).pathname, `/p/${project.id}`);
    assert.equal(new URL(page.url()).search, `?task=${sp.id}`);
    // It has a worktree and a review like any task.
    assert.equal(await page.locator("role=button[name=/^(changes|review)$/i]").count(), 2);
    await ui.run(["press Escape", `click css=[data-task="${sp.id}"] >> role=button[name=/Board/]`]);
    await page.waitForURL(new RegExp(`/t/${sp.id}/board$`));
  });
});

// IA-129: subprojects and scratch tasks are types in the new task dialog, and a scratch task can be in a project or subproject.
test("the new task dialog makes subprojects, and scratch tasks in a project and in a subproject", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click New task", "type /subproject", "press Space", "wait New subproject in Shop"]);
    await ui.run(["type Search overhaul", "press Control+Enter", "gone Reads as", "wait Search overhaul"]);
    await ui.run(["click New task", "type /scratch", "press Space", "wait New scratch task in Shop"]);
    await ui.run(["type How are prices computed?", "press Control+Enter", "gone Reads as", "wait How are prices computed?"]);
    let tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    const sp = tasks.find((t) => t.description === "Search overhaul");
    const scratch = tasks.find((t) => t.description === "How are prices computed?");
    assert.deepEqual([sp.subproject, sp.task_type, sp.use_worktree], [true, null, true]);
    assert.deepEqual([scratch.task_type, scratch.project_id, scratch.use_worktree], ["scratch", project.id, false]);

    // In a subproject there's no Subproject type, as they don't nest.
    await ui.run([`goto /t/${sp.id}/board`, "click New task", "type /", "wait role=option[name=/Scratch/]"]);
    assert.equal(await page.locator("role=option[name=/Subproject/]").count(), 0);
    await ui.run(["type scratch", "press Space", "wait New scratch task in", "type What does search use now?", "press Control+Enter", "gone Reads as"]);
    await ui.run(["wait What does search use now?"]);
    tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    const inner = tasks.find((t) => t.description === "What does search use now?");
    assert.deepEqual([inner.task_type, inner.parent_id], ["scratch", sp.id]);
  });
});
