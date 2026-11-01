import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

// IA-227 with a Claude Code config and a Codex one, whose models the board fetches from the host (faked here, as the
// test server can't run Codex).
let server;
let project;
let codex;
let cart;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  codex = await server.api("POST", "/claude-configs", { name: "Codex", config_dir: `${server.dataDir}/codex`, agent: "codex" });
  await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: [...profile.claude_config_ids, codex.id] });
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  // A git repository whose tasks don't get worktrees unless they ask.
  mkdirSync(`${server.dataDir}/cart`);
  execFileSync("git", ["init", "-q", `${server.dataDir}/cart`]);
  cart = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Cart", repo_path: `${server.dataDir}/cart`, key: "CART", use_worktrees: false });
});
after(() => server?.stop());

const MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: null }];
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const tasksIn = async (description, p = project) => (await server.api("GET", `/projects/${p.id}/tasks`)).filter((t) => t.description === description);
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
      // Asked for meanwhile, it's created once they're in.
      "press Control+Enter",
      "wait It's created once they're in",
      "sleep 300",
    ]);
    assert.equal((await tasksIn("Slow discovery")).length, 0);
    release();
    await ui.run(["gone Reads as"]);
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

// Review of IA-227: a Codex config's default model, named as `!codex`, is known before its models are, but which efforts
// it takes isn't, so an effort waits for them.
test("an effort for a Codex harness waits for its models", async () => {
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
      "type Default discovery !opus !codex ^max",
      "wait Loading Codex's models, to see whether it takes max effort",
      "click Create 2 tasks",
      "wait It's created once they're in",
      "sleep 300",
    ]);
    assert.equal((await tasksIn("Default discovery")).length, 0);
    release();
    await ui.run(["gone Reads as"]);
  });
  const tasks = await tasksIn("Default discovery");
  assert.deepEqual(tasks.map((t) => [t.model, t.effort]).sort(), [
    [null, null],
    ["opus", "max"],
  ]);
});

// Review of IA-227: what's left of a set after a failure is kept with the draft, so it's still made as part of the set
// after the dialog is closed and opened again.
test("the rest of a set are made as part of it after the dialog is closed and opened again", async () => {
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    await ui.page.route(isModels, (route) => route.fulfill(json(MODELS)));
    let posts = 0;
    await ui.page.route(
      (u) => u.pathname.endsWith(`/projects/${cart.id}/tasks`),
      (route) => (route.request().method() === "POST" && ++posts === 2 ? route.fulfill(json({ error: "boom" }, 500)) : route.continue()),
    );
    await ui.run([
      `goto /p/${cart.id}`,
      "click New task",
      "type Reopen retry !opus !gpt-5.5 ^max",
      "press Escape",
      "wait Create 2 tasks",
      "press Control+Enter",
      "wait boom",
      "click Cancel",
      "gone Reads as",
      // Reloaded, too.
      `goto /p/${cart.id}`,
      "click New task",
      "assert document.querySelector('textarea').value === 'Reopen retry !gpt-5.5 ^max'",
      "wait Makes the task left from this prompt, with CART-1, in its own worktree",
      "wait max effort",
      "press Control+Enter",
      "gone Reads as",
    ]);
  });
  const tasks = (await tasksIn("Reopen retry", cart)).sort((a, b) => a.number - b.number);
  assert.deepEqual(
    tasks.map((t) => [t.model, t.effort, t.use_worktree]),
    [
      ["opus", "max", true],
      ["gpt-5.5", null, true],
    ],
  );
  assert.ok(tasks[0].fanout_id && tasks[1].fanout_id === tasks[0].fanout_id);
});

// Review of IA-227: a Codex harness on its default model runs with the model it inherits (here the profile's), so the
// effort is checked against that one, not Codex's default.
test("an effort is checked against the model a default-model harness inherits", async () => {
  const [profile] = await server.api("GET", "/profiles");
  await server.api("PATCH", `/profiles/${profile.id}`, { default_model: "gpt-5.4-mini" });
  try {
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: "medium" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", is_default: false, efforts: ["low", "medium", "high"], default_effort: "medium" },
    ];
    await withBrowser(server, {}, async (ui) => {
      await ui.page.route(isModels, (route) => route.fulfill(json(models)));
      await ui.run([
        `goto /p/${project.id}`,
        "click New task",
        "type Inherited model /scratch !opus !codex ^xhigh",
        "press Escape",
        "wait Create 2 scratch tasks",
        "press Control+Enter",
        "gone Reads as",
      ]);
    });
    const tasks = await tasksIn("Inherited model");
    assert.deepEqual(tasks.map((t) => [t.model, t.effort, t.claude_config_id === codex.id]).sort(), [
      [null, null, true],
      ["opus", "xhigh", false],
    ]);
  } finally {
    await server.api("PATCH", `/profiles/${profile.id}`, { default_model: null });
  }
});

test("family aliases autocomplete and create tasks with the latest model and its effort", async () => {
  const ids = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"];
  const models = ids.map((id) => ({ ...MODELS[0], id, name: id, is_default: id === ids[0], efforts: ["low", "max"] }));
  for (const [alias, model] of [["sol", ids[1]], ["astra", ids[2]], ["terra", ids[3]], ["luna", ids[4]]]) {
    await withBrowser(server, {}, async (ui) => {
      await ui.page.route(isModels, (route) => route.fulfill(json(models)));
      await ui.run([
        `goto /p/${project.id}`, "click New task",
        `type Alias ${alias} /scratch !${alias}`,
        `wait latest · ${model}`,
        // Pick the alias from autocomplete.
        "press Tab",
        `assert document.querySelector('textarea').value.includes('!${alias} ')`,
        "type ^max", "press Escape", "press Control+Enter", "gone Reads as",
      ]);
    });
    const tasks = await tasksIn(`Alias ${alias}`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].model, model);
    assert.equal(tasks[0].effort, "max");
    assert.equal(tasks[0].claude_config_id, codex.id);
  }
});

test("an alias waits for an earlier Codex config that may offer a different latest version", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const earlier = await server.api("POST", "/claude-configs", { name: "Earlier", config_dir: `${server.dataDir}/earlier`, agent: "codex" });
  const original = profile.claude_config_ids;
  await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: [original[0], earlier.id, codex.id] });
  try {
    await withBrowser(server, {}, async (ui) => {
      let release;
      const held = new Promise((r) => (release = r));
      await ui.page.route(isModels, (route) => route.fulfill(json([{ ...MODELS[0], id: "gpt-6.1-sol" }])));
      await ui.page.route((u) => u.pathname.endsWith(`/claude-configs/${earlier.id}/models`), async (route) => {
        await held;
        await route.fulfill(json([{ ...MODELS[0], id: "gpt-6-sol" }]));
      });
      await ui.run([
        `goto /p/${project.id}`, "click New task", "type Alias ordering /scratch !sol",
        "wait Loading Earlier's models", "press Control+Enter", "wait It's created once they're in",
      ]);
      assert.equal((await tasksIn("Alias ordering")).length, 0);
      release();
      await ui.run(["gone Reads as"]);
    });
    const [task] = await tasksIn("Alias ordering");
    assert.equal(task.model, "gpt-6-sol");
    assert.equal(task.claude_config_id, earlier.id);
  } finally {
    await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: original });
  }
});
