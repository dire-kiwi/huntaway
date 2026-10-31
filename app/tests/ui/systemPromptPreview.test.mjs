import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

// HA-50: the project settings' preview of what a new thread's agent is told.
let server, project;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  // New tasks in the project run on Codex, which is told of plan mode in its instructions.
  const codex = await server.api("POST", "/claude-configs", { name: "Codex", config_dir: `${server.dataDir}/codex`, agent: "codex" });
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  await server.api("PATCH", `/projects/${project.id}`, { claude_config_ids: [codex.id] });
});
after(() => server?.stop());

const PLAN_NOTE = "You are in plan mode";
const preview = (page) => page.locator("pre[aria-label='System prompt']");
const showing = (page, text, shown = true) =>
  page.waitForFunction(([t, s]) => document.querySelector("pre[aria-label='System prompt']")?.textContent.includes(t) === s, [text, shown]);

// Review of HA-50: a project left on the host's mode showed a thread out of plan mode, when the host's default is plan.
test("the preview follows the permission mode a new thread inherits", async () => {
  await server.api("PATCH", "/settings", { default_permission_mode: "plan" });
  try {
    await withBrowser(server, {}, async (ui) => {
      const { page } = ui;
      await ui.run([`goto /p/${project.id}/settings/prompts`, "wait SHOP-1"]);
      assert.equal(await page.locator("select[aria-label='Agent']").inputValue(), "codex");
      await showing(page, PLAN_NOTE);
      const toggle = page.getByRole("switch", { name: "Plan mode" });
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      // Switched off, it's out of plan mode, and back on, in it.
      await toggle.click();
      await showing(page, PLAN_NOTE, false);
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      await toggle.click();
      await showing(page, PLAN_NOTE);
      assert.match(await preview(page).textContent(), /worktree at .*1-task-title on branch `ia\/shop-1-task-title`/);
    });
  } finally {
    await server.api("PATCH", "/settings", { default_permission_mode: null });
  }
  // With the host's default back to Ask, a fresh page shows it out of plan mode.
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}/settings/prompts`, "wait SHOP-1"]);
    await showing(ui.page, PLAN_NOTE, false);
    assert.equal(await ui.page.getByRole("switch", { name: "Plan mode" }).getAttribute("aria-checked"), "false");
  });
});
