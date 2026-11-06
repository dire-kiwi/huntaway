import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

// Review of IA-227: with two Codex configs that both have a model, `!model` is the picked config's whatever order their
// models come in, so a prompt doesn't run with another login because its models answered first.
let server;
let project;
let work;
let personal;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  work = await server.api("POST", "/claude-configs", { name: "Work", config_dir: `${server.dataDir}/work`, agent: "codex" });
  personal = await server.api("POST", "/claude-configs", { name: "Personal", config_dir: `${server.dataDir}/personal`, agent: "codex" });
  // Work first, so it's the one picked.
  await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: [work.id, personal.id, ...profile.claude_config_ids] });
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
});
after(() => server?.stop());

const MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", is_default: true, efforts: ["low", "medium", "high"], default_effort: "medium" }];
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const modelsOf = (c) => (u) => u.pathname.endsWith(`/claude-configs/${c.id}/models`);
const tasksIn = async (description) => (await server.api("GET", `/projects/${project.id}/tasks`)).filter((t) => t.description === description);

test("a model two configs have is the picked one's even when another's models come in first", async () => {
  await withBrowser(server, {}, async (ui) => {
    let release;
    const held = new Promise((r) => (release = r));
    await ui.page.route(modelsOf(work), async (route) => {
      await held;
      await route.fulfill(json(MODELS));
    });
    await ui.page.route(modelsOf(personal), (route) => route.fulfill(json(MODELS)));
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Before loading !gpt-5.5 !opus",
      "wait Loading Work's models, to see whether it has !gpt-5.5 too",
      "press Control+Enter",
      "wait It's created once they're in",
      "sleep 300",
    ]);
    assert.equal((await tasksIn("Before loading")).length, 0);
    release();
    await ui.run(["gone Reads as"]);
  });
  const gpt = (await tasksIn("Before loading")).find((t) => t.model === "gpt-5.5");
  assert.equal(gpt.claude_config_id, work.id);
});

test("if the picked config's models can't be fetched, a model another config has waits to be named with its config", async () => {
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    await ui.page.route(modelsOf(work), (route) => route.fulfill(json({ error: "signed out" }, 500)));
    await ui.page.route(modelsOf(personal), (route) => route.fulfill(json(MODELS)));
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "type Work down !gpt-5.5 !opus",
      "wait Couldn't load Work's models",
      "wait !gpt-5.5.personal",
      "assert document.querySelector('button[type=submit]').disabled",
      // Named with its config, it's Personal's.
      "press Control+a",
      "type Work down !gpt-5.5.personal !opus",
      "press Escape",
      "gone Couldn't load Work's models",
      "press Control+Enter",
      "gone Reads as",
    ]);
  });
  const gpt = (await tasksIn("Work down")).find((t) => t.model === "gpt-5.5");
  assert.equal(gpt.claude_config_id, personal.id);
});
