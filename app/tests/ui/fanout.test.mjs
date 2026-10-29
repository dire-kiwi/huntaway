import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
let project;
let plain;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  plain = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Plain", repo_path: `${server.dataDir}/plain`, key: "PL" });
});
after(() => server?.stop());

const tasksIn = async (p, description) => (await server.api("GET", `/projects/${p.id}/tasks`)).filter((t) => t.description === description);

// IA-227: as t3code sends one prompt to several models, each `!model` makes a task from the same prompt, in its own
// worktree, and they're shown side by side.
test("several models make a task each from one prompt, and their cards and details say which is which", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Add a health check !opus !sonnet",
      "press Escape",
      "wait Makes 2 tasks from this prompt",
      // Each is in its own worktree, so the toggle goes.
      "gone Own git worktree",
      "press Control+Enter",
      "gone Reads as",
    ]);
    const tasks = await tasksIn(project, "Add a health check");
    assert.deepEqual(
      tasks.map((t) => [t.model, t.use_worktree]).sort(),
      [
        ["opus", true],
        ["sonnet", true],
      ],
    );
    assert.ok(tasks[0].fanout_id && tasks[0].fanout_id === tasks[1].fanout_id);
    const [opus, sonnet] = tasks.sort((a, b) => a.model.localeCompare(b.model));
    await ui.run([
      `wait [data-task="${opus.id}"] >> text=opus`,
      `wait [data-task="${sonnet.id}"] >> text=sonnet`,
      `goto /p/${project.id}?task=${opus.id}`,
      "click Details",
      "wait Same prompt",
      `click css=aside button:has-text("SHOP-${sonnet.number}")`,
      `assert location.search.includes('${sonnet.id}')`,
    ]);
  });
});

test("a model that couldn't be made stays in the text, and trying again makes it with the others", async () => {
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    let posts = 0;
    await ui.page.route(
      (u) => u.pathname.endsWith(`/projects/${project.id}/tasks`),
      (route) =>
        route.request().method() === "POST" && ++posts === 2
          ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
          : route.continue(),
    );
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Partial run !haiku !sonnet !fable",
      "press Escape",
      "wait Create 3 tasks",
      "press Control+Enter",
      "wait boom",
      "assert document.querySelector('textarea').value === 'Partial run !sonnet !fable'",
      "wait Create 2 tasks",
      "press Control+Enter",
      "gone Reads as",
    ]);
  });
  const tasks = await tasksIn(project, "Partial run");
  assert.deepEqual(tasks.map((t) => t.model).sort(), ["fable", "haiku", "sonnet"]);
  assert.equal(new Set(tasks.map((t) => t.fanout_id)).size, 1);
});

test("a subproject or a project that isn't a git repository takes one model", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${plain.id}`,
      "click New task",
      "type Try it !opus !sonnet",
      "press Escape",
      "wait isn't a git repository",
      "assert document.querySelector('button[type=submit]').disabled",
      // A scratch task works in its own folder, so it can.
      "press Space",
      "type /scratch",
      "press Space",
      "wait Create 2 scratch tasks",
      "assert !document.querySelector('button[type=submit]').disabled",
      `goto /p/${project.id}`,
      "click New task",
      "type Split it /subproject !opus !sonnet",
      "press Escape",
      "wait A subproject has one agent",
      "assert document.querySelector('button[type=submit]').disabled",
    ]);
  });
});

test("one model, or none, makes one task as before", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}`, "click New task", "type Only one !opus", "press Escape", "wait Create task", "press Control+Enter", "gone Reads as"]);
  });
  const [task] = await tasksIn(project, "Only one");
  assert.deepEqual([task.model, task.fanout_id ?? null], ["opus", null]);
});
