import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

// IA-227 with a Claude Code config and a Codex one, whose models the board fetches from the host (faked here, as the
// test server can't run Codex).
let server;
let project;
let codex;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const [profile] = await server.api("GET", "/profiles");
  codex = await server.api("POST", "/claude-configs", { name: "Codex", config_dir: `${server.dataDir}/codex`, agent: "codex" });
  await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: [...profile.claude_config_ids, codex.id] });
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
});
after(() => server?.stop());

const MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: null }];
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const tasksIn = async (description) => (await server.api("GET", `/projects/${project.id}/tasks`)).filter((t) => t.description === description);
const isModels = (u) => u.pathname.endsWith(`/claude-configs/${codex.id}/models`);
const disabled = "document.querySelector('button[type=submit]').disabled";

// Review of IA-227: a Codex model named before Codex's models are in waits for them, rather than going as text.
test("a model named before its config's models are in waits for them", async () => {
  await withBrowser(server, {}, async (ui) => {
    let release;
    const held = new Promise((r) => (release = r));
    await ui.page.route(isModels, async (route) => {
      await held;
      await route.fulfill(json(MODELS));
    });
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      // No list is open for it (there's nothing to offer yet), so Escape would close the dialog.
      "type Slow discovery !opus !gpt-5.5",
      "wait Loading Codex's models",
      `assert ${disabled}`,
      "press Control+Enter",
      "sleep 300",
    ]);
    assert.equal((await tasksIn("Slow discovery")).length, 0);
    release();
    await ui.run(["wait Create 2 tasks", "gone Loading Codex's models", "press Control+Enter", "gone Reads as"]);
  });
  const tasks = await tasksIn("Slow discovery");
  assert.deepEqual(tasks.map((t) => [t.model, t.claude_config_id === codex.id]).sort(), [
    ["gpt-5.5", true],
    ["opus", false],
  ]);
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id);
});

test("a model whose config's models couldn't be fetched isn't sent as text", async () => {
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    await ui.page.route(isModels, (route) => route.fulfill(json({ error: "codex isn't installed" }, 500)));
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      // No list is open for it (there's nothing to offer yet), so Escape would close the dialog.
      "type No discovery !opus !gpt-5.5",
      "wait Couldn't load Codex's models",
      `assert ${disabled}`,
    ]);
  });
  assert.equal((await tasksIn("No discovery")).length, 0);
});

// Review of IA-227: an effort only a task already made takes is still an effort when the rest are made.
test("after a failure, the rest are made from the same prompt and options", async () => {
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    await ui.page.route(isModels, (route) => route.fulfill(json(MODELS)));
    let posts = 0;
    await ui.page.route(
      (u) => u.pathname.endsWith(`/projects/${project.id}/tasks`),
      (route) => (route.request().method() === "POST" && ++posts === 2 ? route.fulfill(json({ error: "boom" }, 500)) : route.continue()),
    );
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Effort retry !opus !gpt-5.5 ^max",
      "press Escape",
      "wait Create 2 tasks",
      "press Control+Enter",
      "wait boom",
      "assert document.querySelector('textarea').value === 'Effort retry !gpt-5.5 ^max'",
      "wait max effort",
      "press Control+Enter",
      "gone Reads as",
    ]);
  });
  const tasks = (await tasksIn("Effort retry")).sort((a, b) => a.number - b.number);
  // Codex's gpt-5.5 doesn't take max, so it gets its default.
  assert.deepEqual(
    tasks.map((t) => [t.model, t.effort]),
    [
      ["opus", "max"],
      ["gpt-5.5", null],
    ],
  );
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id);
});
