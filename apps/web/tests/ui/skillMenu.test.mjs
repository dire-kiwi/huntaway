import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-146: typing `/` lists the agent's skills. Enter pressed before the list came back used to send the half-typed command.
test("the / menu waits for the skills, picks one and closes on Escape", async () => {
  const content = "---\nname: release-notes\ndescription: Write the release notes.\n---\n\nWrite them.\n";
  await server.api("POST", `/projects/${project.id}/agent-tools/skills`, { content });
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Notes", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // A slow host, so Enter lands while the list is loading.
    await page.route("**/skills", async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type /rel", "press Enter"]);
    const value = () => page.locator("textarea").inputValue();
    assert.equal(await value(), "/rel");
    await ui.run(["wait Write the release notes.", "press Enter"]);
    assert.equal(await value(), "/release-notes ");
    await ui.run(["wait /release-notes [arguments]"]);
    const messages = await server.api("GET", `/tasks/${task.id}/messages`);
    assert.ok(!JSON.stringify(messages).includes("/rel"), "nothing was sent");
    // Escape closes the menu, not the task's panel.
    await ui.run(["press Control+a", "type /", "wait Write the release notes.", "press Escape", "gone Write the release notes."]);
    assert.ok(new URL(page.url()).pathname.startsWith("/t/") || page.url().includes("task="), page.url());
    await ui.run(["wait css=textarea"]);
  });
});

// HA-87: `/plan` is the board's, beside `/compact`: it gives the task the plan label and tells its agent how to write the plan.
test("the / menu offers /plan, over a skill of the same name", async () => {
  const content = "---\nname: plan\ndescription: A skill called plan.\n---\n\nPlan.\n";
  await server.api("POST", `/projects/${project.id}/agent-tools/skills`, { content });
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Plan it", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type /pla", "wait Write a plan in the task's Plan tab"]);
    assert.equal(await page.getByRole("option").count(), 1, "the skill named plan isn't listed");
    await ui.run(["press Tab", "wait /plan [what to plan]"]);
    assert.equal(await page.locator("textarea").inputValue(), "/plan ");
  });
});

/** A Codex config on the demo profile, beside its Claude one; returns [codex, claude] config ids. */
async function addCodexConfig() {
  const [profile] = await server.api("GET", "/profiles");
  const configs = await server.api("GET", "/claude-configs");
  let codex = configs.find((c) => c.agent === "codex");
  if (!codex) {
    codex = await server.api("POST", "/claude-configs", { name: "Codex", config_dir: "", agent: "codex" });
    const ids = profile.claude_config_ids?.length ? profile.claude_config_ids : configs.map((c) => c.id);
    await server.api("PATCH", `/profiles/${profile.id}`, { claude_config_ids: [...ids, codex.id] });
  }
  const claude = configs.find((c) => (c.agent ?? "claude") === "claude");
  return [codex.id, claude.id];
}

// The test server can't run Codex, so listing a Codex config's models fails.
const codexModels = { allowErrors: [/status of 400 .*\/models\)$/] };

// IA-146 review: `$` is Codex's, so it used to wait for a list that only `/` would load.
test("$ lists a Codex task's skills before anything else has loaded them", async () => {
  const [codex] = await addCodexConfig();
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Codex notes", status: "in_review", claude_config_id: codex });
  await withBrowser(server, codexModels, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type $rel", "wait $release-notes", "press Enter"]);
    assert.equal(await ui.page.locator("textarea").inputValue(), "$release-notes ");
  });
});

// IA-146 review: the list was kept per task, so after a switch to another config it still offered the old agent's skills.
test("the / menu follows a switch to another config", async () => {
  const [codex, claude] = await addCodexConfig();
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Switch", status: "in_review", claude_config_id: codex });
  await withBrowser(server, codexModels, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click thread", "click css=textarea", "type /rel", "wait $release-notes", "press Escape", "press Control+a", "press Backspace"]);
    await server.api("PATCH", `/tasks/${task.id}`, { claude_config_id: claude });
    await ui.run(["sleep 500", "type /rel", "wait /release-notes", "press Enter"]);
    assert.equal(await ui.page.locator("textarea").inputValue(), "/release-notes ");
    // And `$` isn't a Claude agent's.
    await ui.run(["press Control+a", "type $rel", "sleep 300", "assert !document.querySelector('[role=listbox]')"]);
  });
});
