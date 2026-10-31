import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** The ids of the To do column's cards, top to bottom. */
const todoCards = (page) =>
  page.evaluate(() => {
    const col = [...document.querySelectorAll("section")].find((s) => /To do/.test(s.textContent) && s.querySelector("[data-task]"));
    return [...col.querySelectorAll("[data-task]")].map((c) => c.dataset.task);
  });

/**
 * Drags the To do column's card `which` over the top half of its card `onto` and drops it there, as a mouse would:
 * several dragover events with renders between them (the drop line is React state), then the drop.
 */
async function dragOnto(page, which, onto) {
  const fire = (types) =>
    page.evaluate(
      ([which, onto, types]) => {
        const col = [...document.querySelectorAll("section")].find((s) => /To do/.test(s.textContent) && s.querySelector("[data-task]"));
        const cards = [...col.querySelectorAll("[data-task]")];
        const [src, target] = [cards[which], cards[onto]];
        const dt = new DataTransfer();
        dt.setData("text/task-id", src.dataset.task);
        const r = target.getBoundingClientRect();
        for (const type of types) {
          const el = type === "dragstart" || type === "dragend" ? src : target;
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 4 }));
        }
      },
      [which, onto, types],
    );
  await fire(["dragstart", "dragenter", "dragover"]);
  await page.waitForTimeout(150);
  await fire(["dragover"]);
  await page.waitForTimeout(150);
  await fire(["drop", "dragend"]);
  await page.waitForTimeout(600);
}

// HA-32: a card dropped on its own top half (the drop line shows above it, so it looks like "stay") went to the end of
// the column, with a position update sent: the card dragged is left out of the column the drop position is worked out
// in, so "before itself" was nowhere.
test("a card dropped on itself stays where it is", async () => {
  // A third card, so the one in the middle has cards on both sides.
  await server.api("POST", `/projects/${project.id}/tasks`, { title: "Third card" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "wait Third card"]);
    const patches = [];
    page.on("request", (r) => r.method() === "PATCH" && /\/tasks\//.test(r.url()) && patches.push(r.url()));
    const before = await todoCards(page);
    assert.equal(before.length, 3);

    await dragOnto(page, 1, 1);
    assert.deepEqual(await todoCards(page), before, "the order after a self-drop");
    assert.deepEqual(patches, [], "nothing to save after a self-drop");

    // The same drag onto another card moves it, so the drop above proves something.
    await dragOnto(page, 1, 0);
    assert.deepEqual(await todoCards(page), [before[1], before[0], before[2]]);
    assert.ok(patches.length, "a real move is saved");
  });
});
