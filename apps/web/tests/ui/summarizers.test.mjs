import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// HA-141: a project can have several summarizers, each with a name, skills and a prompt of its own, to compare them.
test("edits a project's several summarizers, and keeps each one's text when another is removed", async () => {
  await server.api("PATCH", `/projects/${project.id}`, {
    summarizers: [
      { name: "One", skills: ["tldr", "changelog"] },
      { name: "Two", skills: ["review"] },
    ],
  });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const names = page.locator('input[placeholder="Name"]');
    const skills = page.locator('input[placeholder^="Skills to use"]');
    await ui.run([`goto /p/${project.id}/settings/review`, "wait Add summarizer"]);
    assert.deepEqual(await names.evaluateAll((els) => els.map((e) => e.value)), ["One", "Two"]);
    // A skill list being typed can end in a comma.
    await ui.run(["click Add summarizer"]);
    await names.nth(2).fill("Three");
    await skills.nth(2).pressSequentially("a, ");
    assert.equal(await skills.nth(2).inputValue(), "a, ");
    // The first one goes: the rest keep their own names and skills.
    await page.locator('button[title="Remove this reviewer"]').first().click();
    assert.deepEqual(await names.evaluateAll((els) => els.map((e) => e.value)), ["Two", "Three"]);
    assert.deepEqual(await skills.evaluateAll((els) => els.map((e) => e.value)), ["review", "a, "]);
    await ui.run(["click Save changes"]);
    await page.waitForFunction(() => !/Save changes/.test(document.body.innerText) || document.querySelector("button:disabled"));
    const saved = await server.api("GET", `/projects/${project.id}`);
    assert.deepEqual(
      saved.summarizers.map((s) => [s.name, s.skills]),
      [
        ["Two", ["review"]],
        ["Three", ["a"]],
      ],
    );
    // What hosts from before several summarizers read is the first.
    assert.equal(saved.summarizer.name, "Two");
  });
});
