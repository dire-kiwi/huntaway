import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Drags from one element's centre to another's, as a person does with the mouse. */
async function drag(page, from, to, { dx = 0, dy = 0 } = {}) {
  const a = await page.locator(from).boundingBox();
  const b = to ? await page.locator(to).boundingBox() : null;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const x = b ? b.x + b.width / 2 : a.x + a.width / 2 + dx;
  const y = b ? b.y + b.height / 2 : a.y + a.height / 2 + dy;
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

// HA-173: the node editor: a preset, a step added and connected by dragging, a connection removed, and a step moved, saved as shown.
test("a workflow made in its editor saves the graph it shows", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}/settings/workflows`, "wait No workflows yet", "click role=button[name=/Review and summarise/]", "wait [data-testid=workflow-canvas]"]);
    // A loop is refused: the summary can't lead back into the check.
    await drag(page, "[data-port='summary.done']", "[data-node=changed]");
    await ui.run(["wait That would make a loop"]);
    await ui.run(["click role=button[name=/^Agent$/]", "wait [data-node=agent1]"]);
    await drag(page, "[data-port='reviewer.failed']", "[data-node=agent1]");
    await ui.run(["click [data-testid=workflow-inspector] >> role=textbox[name=\"Name\"s]", "press Control+a", "type Notes"]);
    // Removes the check's connection to the reviewer by clicking its line.
    await page.locator("[data-edge='changed.yes->reviewer']").dispatchEvent("pointerdown", { button: 0 });
    await ui.run(["wait text=Connection", "click [data-testid=workflow-inspector] >> role=button[name=/Remove/]"]);
    const before = await page.locator("[data-node=summary]").boundingBox();
    await drag(page, "[data-node=summary] >> text=Writes text", null, { dx: 0, dy: 60 });
    const moved = await page.locator("[data-node=summary]").boundingBox();
    assert.ok(Math.abs(moved.y - before.y - 60) <= 10, `moved by ${moved.y - before.y}`);
    await ui.run(["click Create workflow", "gone [role=dialog]", "wait Review and summarise"]);

    const { workflows } = await server.api("GET", `/projects/${project.id}/workflows`);
    assert.equal(workflows.length, 1);
    const g = workflows[0].graph;
    const edges = g.edges.map((e) => `${e.from}.${e.port}->${e.to}`).sort();
    assert.deepEqual(edges, ["reviewer.failed->agent1", "reviewer.issues->fix", "reviewer.pass->summary", "start.out->changed"]);
    const notes = g.nodes.find((n) => n.id === "agent1");
    assert.equal(notes.kind, "agent");
    assert.equal(notes.name, "Notes");
    const summary = g.nodes.find((n) => n.id === "summary");
    assert.ok(Math.abs(summary.y - 250) <= 10, `summary at ${summary.y}`);

    // Opened again, it shows what it was saved with, and saves it unchanged.
    await ui.run(["click role=button[name=/^Edit$/]", "wait Edit Review and summarise", "wait [data-node=agent1]", "click Save", "gone [role=dialog]"]);
    const again = await server.api("GET", `/workflows/${workflows[0].id}`);
    assert.deepEqual(again.graph, g);
  });
});

// HA-173: a workflow's agent steps show in the task panel's tabs, and it can be run from the task's details.
test("a task's workflow runs show in the tabs its steps name", async () => {
  const w = await server.api("POST", `/projects/${project.id}/workflows`, {
    name: "Notes by hand",
    graph: {
      nodes: [
        { id: "start", kind: "trigger", on: "manual", x: 0, y: 0 },
        { id: "notes", kind: "agent", name: "Release notes", prompt: "Write release notes.", output: "text", tab: "Notes", x: 200, y: 0 },
      ],
      edges: [{ from: "start", port: "out", to: "notes" }],
    },
  });
  const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
  const task = tasks.find((t) => t.kind === "task" && !t.running && t.status !== "done");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "wait Notes by hand", "click role=button[name=\"Run Notes by hand\"s]", "wait role=button[name=\"Notes\"s]", "click role=button[name=\"Notes\"s]"]);
    // Agents can't run on this server, so the step fails; it still shows where its output goes.
    await ui.run(["wait Release notes", "wait Notes by hand"]);
  });
  const { runs } = await server.api("GET", `/tasks/${task.id}/workflow-runs`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workflow_id, w.id);
});
