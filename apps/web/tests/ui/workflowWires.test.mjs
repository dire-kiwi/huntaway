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
