import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-126: a title re-titled from a message while it was being renamed replaced what was typed, and Enter saved it.
test("a title that changes while it's being renamed keeps the draft", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Old name" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "dblclick css=h1[title='Double-click to rename']", "press Control+a", "type My preferred title"]);
    // As a refresh from the user's messages changes it: a new title that isn't pinned.
    await server.api("PATCH", `/tasks/${task.id}`, { title: "Refresh result", title_pinned: false });
    await ui.run(["wait Refresh result"]);
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").inputValue(), "My preferred title");
    await ui.run(["press Enter"]);
    let saved;
    for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100)) {
      saved = (await server.api("GET", `/tasks/${task.id}`)).task;
      if (saved.title !== "Refresh result") break;
    }
    assert.deepEqual([saved.title, saved.title_pinned], ["My preferred title", true]);
    // Not being edited, it follows the task again.
    await server.api("PATCH", `/tasks/${task.id}`, { title: "Another refresh", title_pinned: false });
    await ui.run(["wait css=h1:has-text('Another refresh')", "dblclick css=h1[title='Double-click to rename']"]);
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").inputValue(), "Another refresh");
  });
});

// IA-126: the rename field stayed open with its draft when the panel moved to another task, and Enter renamed that one.
test("a rename doesn't follow the panel to another task", async () => {
  const a = await server.api("POST", `/projects/${project.id}/tasks`, { title: "First task" });
  const b = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Second task" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}?task=${a.id}`, "wait css=h1:has-text('First task')", "click Second task", "wait css=h1:has-text('Second task')"]);
    await ui.run(["dblclick css=h1[title='Double-click to rename']", "press Control+a", "type Draft for second task"]);
    await page.goBack();
    await ui.run(["wait css=h1:has-text('First task')"]);
    assert.equal(await page.locator("header input:not([aria-label='Search tasks'])").count(), 0);
    await ui.run(["press Enter"]);
    await page.waitForTimeout(300);
    const titles = await Promise.all([a, b].map(async (t) => (await server.api("GET", `/tasks/${t.id}`)).task.title));
    assert.deepEqual(titles, ["First task", "Second task"]);
  });
});

/** The task's title and whether it's pinned once its title is no longer `old`, as the server has them. */
async function savedTitle(page, task, old) {
  let saved;
  for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100)) {
    saved = (await server.api("GET", `/tasks/${task.id}`)).task;
    if (saved.title !== old) break;
  }
  return [saved.title, saved.title_pinned];
}

// HA-100: a card's right-click menu sets its title in a dialog, which pins it.
test("Set title… in a card's menu renames the task", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Named by its prompt" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "rclick Named by its prompt", "click [role=menu] >> text=Set title…", "wait [role=dialog]"]);
    assert.equal(await page.locator("[role=dialog] input[aria-label=Title]").inputValue(), "Named by its prompt");
    await ui.run(["press Control+a", "type Named from the menu", "press Enter", "gone [role=dialog]", "wait Named from the menu"]);
    assert.deepEqual(await savedTitle(page, task, "Named by its prompt"), ["Named from the menu", true]);
  });
});

// HA-100: the task's details have its title, to rename and to unpin.
test("the details' Title section renames and unpins the title", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Before the details" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const section = "css=section:has(h3:text-is('Title'))";
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", "click Edit title", "press Control+a", "type Renamed in the details"]);
    // Escape leaves the panel open, and the title as it was.
    await ui.run(["press Escape", `gone ${section} >> input`, "click Edit title"]);
    assert.equal(await page.locator(`${section.slice(4)} input`).inputValue(), "Before the details");
    await ui.run(["press Control+a", "type Renamed in the details", "press Enter", `wait ${section} >> text=Set by hand`]);
    assert.deepEqual(await savedTitle(page, task, "Before the details"), ["Renamed in the details", true]);
    await ui.run([`click ${section} >> text=Unpin`, `gone ${section} >> text=Set by hand`]);
    assert.equal((await server.api("GET", `/tasks/${task.id}`)).task.title_pinned, false);
  });
});
