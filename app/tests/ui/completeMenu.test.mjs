import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const TITLE = "Try dragging this card to another column";
// The heading of the board column a card is in.
const columnOf = (page, title) =>
  page.evaluate((title) => {
    const card = [...document.querySelectorAll("[data-task]")].find((c) => c.textContent.includes(title));
    return card?.closest("section")?.querySelector("span.font-medium")?.textContent;
  }, title);

// IA-53: completing a task from its right-click menu moves it to Done at once, and puts it back if the save fails.
test("a failed complete from the card menu shows the error and puts the card back", async () => {
  await withBrowser(server, { allowErrors: ["status of 400"] }, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, `wait ${TITLE}`]);
    const before = await columnOf(page, TITLE);
    // Saves go to /api/h/<host>/tasks/<id>.
    await page.route("**/tasks/*", (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"nope"}' }) : route.continue(),
    );
    await ui.run([`rclick ${TITLE}`, "wait [role=menu]", "click [role=menu] >> text=Won't fix", "wait nope", "gone [role=menu]"]);
    assert.equal(await columnOf(page, TITLE), before);
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    assert.equal(tasks.find((t) => t.title === TITLE).status, "todo");

    // Without the failure it's done, with the resolution picked.
    await page.unrouteAll();
    await ui.run([`rclick ${TITLE}`, "click [role=menu] >> text=Not done", "gone [role=menu]", "gone nope"]);
    await page.waitForFunction(
      async ([url, token, title]) => {
        // The server, not the board's optimistic copy.
        const tasks = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
        const t = tasks.find((t) => t.title === title);
        return t.status === "done" && t.resolution === "not_done";
      },
      [`/api/projects/${project.id}/tasks`, server.token, TITLE],
    );
  });
});
