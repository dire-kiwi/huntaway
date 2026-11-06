import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const until = async (page, fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) {
    const v = await fn();
    if (v) return v;
  }
  return fn();
};

// HA-40: deleting a profile was fire-and-forget: a refusal (agents running, a host offline) left the page as it was with
// no message, and a double-click sent it twice.
test("a refused delete shows its error in the dialog, and a double-click deletes once", async () => {
  await server.api("POST", "/profiles", { name: "Spare", claude_config_dir: "~/.claude-spare" });
  await withBrowser(server, { allowErrors: [/status of 409/] }, async (ui) => {
    const { page } = ui;
    let refuse = true;
    let deletes = 0;
    await page.route("**/api/h/*/profiles/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes++;
      if (refuse) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Spare has agents running" }) });
      // Slow, so a second click lands while the first is on its way.
      await new Promise((r) => setTimeout(r, 400));
      return route.fallback();
    });
    const row = page.locator("section:has(> div > h2:text-is('Profiles')) .rounded-xl:has(> div:text-is('Spare'))");
    await ui.run(["goto /settings", "wait css=h2:text-is('Profiles')"]);
    await row.locator("button[title='Delete']").click();
    await ui.run(["wait css=[role=dialog] >> text=Delete profile Spare", "click css=[role=dialog] button:has-text('Delete profile')"]);
    await ui.run(["wait Spare has agents running"]);
    assert.equal(await page.locator("[role=dialog]").count(), 1, "the dialog stays open with the error");

    refuse = false;
    deletes = 0;
    await page.locator("[role=dialog] button:has-text('Delete profile')").dblclick();
    await ui.run(["gone css=[role=dialog]"]);
    const profiles = await until(page, async () => {
      const list = await server.api("GET", "/profiles");
      return list.some((p) => p.name === "Spare") ? null : list;
    });
    assert.ok(profiles, "the profile is deleted");
    assert.equal(deletes, 1, "a double-click sends one request");
  });
});

// HA-40: the Pull request and Preview fields took the task's value on every change, so typing in one was overwritten when
// the agent set it, and a field that wasn't touched could write an old value back.
test("a task's text field keeps what's typed while the task changes, and follows it once left", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Fields" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const preview = page.locator("input[placeholder^='https://… (where to try']");
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click details", "wait css=input[placeholder^='https://… (where to try']"]);
    await preview.click();
    await page.keyboard.type("https://typed.example");
    await server.api("PATCH", `/tasks/${task.id}`, { preview_url: "https://agent.example" });
    await page.waitForTimeout(500);
    assert.equal(await preview.inputValue(), "https://typed.example");
    await page.keyboard.press("Enter");
    const saved = await until(page, async () => {
      const t = (await server.api("GET", `/tasks/${task.id}`)).task;
      return t.preview_url === "https://typed.example" && t;
    });
    assert.ok(saved, "what was typed is saved");

    // Focused but not changed: a value set meanwhile isn't written over on leaving, and shows once it's left.
    await preview.click();
    await server.api("PATCH", `/tasks/${task.id}`, { preview_url: "https://agent2.example" });
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await until(page, async () => (await preview.inputValue()) === "https://agent2.example");
    assert.equal(await preview.inputValue(), "https://agent2.example");
    await page.waitForTimeout(300);
    assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.preview_url, "https://agent2.example");
  });
});

// HA-40: model and effort changes had no .catch, so a refused one looked saved.
test("a refused model change says so", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Model" });
  await withBrowser(server, { allowErrors: [/status of 500/] }, async (ui) => {
    const { page } = ui;
    await page.route(`**/api/h/*/tasks/${task.id}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) })
        : route.fallback(),
    );
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click details"]);
    const model = page.locator("section", { hasText: "Session" }).locator("input").first();
    await model.click();
    await page.keyboard.type("opus");
    await page.keyboard.press("Enter");
    await ui.run(["wait Couldn't change the model: disk full"]);
    assert.equal(await model.inputValue(), "opus", "what was typed stays, to try again");
  });
});
