import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

/** Drags from one element's middle to another's, as a person wiring two sockets does. */
async function drag(page, from, to) {
  const a = await page.locator(from).boundingBox();
  const b = await page.locator(to).boundingBox();
  assert.ok(a && b, `${from} and ${to} are on the page`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
}

// HA-276: data wires, Blender-style: a value node's output into a step's input replaces that input's own text.
test("a value wired into a column's prompt is saved, and unwiring it brings its field back", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}/settings/workflows`, "click role=button[name='Work, PR and review']", "wait Pushes the branch"]);
    await ui.page.getByRole("button", { name: "Text", exact: true }).click();
    await ui.run(["wait [data-node=text1]", "click [data-testid=workflow-inspector] textarea", "type Use TDD."]);
    await drag(ui.page, "[data-output='text1.text']", "[data-input='work.prompt']");
    await ui.run(["wait [data-edge='text1.text->work.prompt']", "click [data-node=work]", "wait [data-testid=wired-prompt]"]);
    // A loop of values is refused.
    await ui.page.getByRole("button", { name: "Compose", exact: true }).click();
    await ui.run(["wait [data-node=compose1]"]);
    await drag(ui.page, "[data-output='compose1.text']", "[data-input='compose1.a']");
    await ui.run(["gone [data-edge='compose1.text->compose1.a']"]);
    await ui.run(["click Create workflow", "gone [role=dialog]"]);
    const { workflows } = await server.api("GET", `/projects/${project.id}/workflows`);
    const w = workflows.find((x) => x.name === "Work, pull request and review");
    assert.ok(w.graph.edges.some((e) => e.from === "text1" && e.port === "text" && e.to === "work" && e.input === "prompt"));
    assert.equal(w.graph.nodes.find((n) => n.id === "text1").text, "Use TDD.");
    // Unwired, its own field is back.
    await ui.run(["wait Work, pull request and review", "click role=button[name='Edit']", "click [data-node=work]", "wait [data-testid=wired-prompt]"]);
    await ui.page.getByTitle("Unwire it, to use its own text").click();
    await ui.run(["gone [data-testid=wired-prompt]", "gone [data-edge='text1.text->work.prompt']"]);
  });
});

test("a wire into an input that goes from a template goes with it", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}/settings/workflows`, "click role=button[name='New workflow']", "wait [data-node=start]"]);
    await ui.page.getByRole("button", { name: "Compose", exact: true }).click();
    await ui.page.getByRole("button", { name: "Text", exact: true }).click();
    await ui.run(["wait [data-node=text1]"]);
    await drag(ui.page, "[data-output='text1.text']", "[data-input='compose1.b']");
    await ui.run(["wait [data-edge='text1.text->compose1.b']", "click [data-node=compose1]"]);
    await ui.page.locator("[data-testid=workflow-inspector] textarea").fill("Only {{a}} now.");
    await ui.run(["gone [data-edge='text1.text->compose1.b']", "gone [data-input='compose1.b']"]);
  });
});

const transform = (page) => page.locator("[data-testid=workflow-canvas]").evaluate((el) => el.style.transform);

// HA-276: the canvas pans and zooms, and a right-drag across wires cuts them, as Blender's node editor does.
test("the canvas pans and zooms, and a right-drag cuts the wires it crosses", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}/settings/workflows`, "click role=button[name='Open a PR when done']", "wait [data-edge='start.done->commits']"]);
    const box = await page.locator("[data-testid=workflow-viewport]").boundingBox();
    // The wheel zooms around the pointer.
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.wheel(0, 400);
    await ui.run(["assert document.querySelector('[data-testid=workflow-zoom]').textContent !== '100%'"]);
    assert.match(await transform(page), /scale\(0\.\d+\)/);
    // Dragging the background pans.
    const before = await transform(page);
    await page.mouse.move(box.x + box.width - 60, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 160, box.y + 80, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await transform(page), before);
    // Fit brings the whole workflow into view.
    await page.getByTitle("Fit the whole workflow in view").click();
    for (const id of ["start", "commits", "pr", "review", "attention"]) {
      const b = await page.locator(`[data-node=${id}]`).boundingBox();
      assert.ok(b.x >= box.x && b.x + b.width <= box.x + box.width && b.y >= box.y && b.y + b.height <= box.y + box.height, `${id} is in view`);
    }
    // Zoomed out, wiring a value still lands on its input.
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await ui.run(["wait [data-node=text1]"]);
    await page.getByTitle("Fit the whole workflow in view").click();
    await drag(page, "[data-output='text1.text']", "[data-input='start.prompt']");
    await ui.run(["wait [data-edge='text1.text->start.prompt']"]);
    // A right-drag across the start's line to the check cuts it, and no menu opens.
    const edge = await page.locator("[data-edge='start.done->commits']").boundingBox();
    const [cx, cy] = [edge.x + edge.width / 2, edge.y + edge.height / 2];
    await page.mouse.move(cx, cy - 40);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(cx, cy, { steps: 4 });
    await page.mouse.move(cx, cy + 40, { steps: 4 });
    await ui.run(["assert !!document.querySelector('[data-testid=workflow-cut]')"]);
    await page.mouse.up({ button: "right" });
    await ui.run([
      "gone [data-edge='start.done->commits']",
      "assert !document.querySelector('[data-testid=workflow-cut]')",
      "wait [data-edge='commits.yes->pr']",
    ]);
  });
});

// HA-276: Delete or X removes the selected node or line, as in Blender, but not while typing in a field.
test("delete and x remove the selected node or line", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}/settings/workflows`, "click role=button[name='Open a PR when done']", "wait [data-edge='start.done->commits']"]);
    await page.locator("[data-edge='start.done->commits']").click({ force: true });
    await page.keyboard.press("Delete");
    await ui.run(["gone [data-edge='start.done->commits']"]);
    await ui.run(["click [data-node=attention]"]);
    await page.keyboard.press("x");
    await ui.run(["gone [data-node=attention]", "gone [data-edge='pr.failed->attention']"]);
    // Typing an x in a field types it.
    await ui.run(["click [data-node=pr]"]);
    await page.locator("[data-testid=workflow-inspector] input").nth(1).click();
    await page.keyboard.type("x");
    await ui.run(["wait [data-node=pr]"]);
  });
});
