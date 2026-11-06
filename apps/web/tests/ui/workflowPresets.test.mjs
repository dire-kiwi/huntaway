import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

const workflow = async (name) => {
  for (let i = 0; i < 50; i++) {
    const { workflows } = await server.api("GET", `/projects/${project.id}/workflows`);
    const w = workflows.find((w) => w.name === name);
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no workflow ${name}`);
};

// HA-276: a workflow that starts when the task's agent finishes, opens its pull request and moves it to In review.
test("the pull request preset saves a finished trigger and its pull request step", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Open a PR when done']",
      "wait Pushes the branch",
      "click [data-node=pr]",
      "click Open it as a draft",
      "click Create workflow",
      "gone [role=dialog]",
      "wait When the task's agent finishes · pull request",
    ]);
    const w = await workflow("Open a pull request, then review");
    const kinds = Object.fromEntries(w.graph.nodes.map((n) => [n.id, n]));
    assert.equal(kinds.start.on, "finished");
    assert.ok(!("status" in kinds.start));
    assert.deepEqual([kinds.pr.kind, kinds.pr.draft], ["open_pr", true]);
    assert.ok(w.graph.edges.some((e) => e.from === "pr" && e.port === "opened" && e.to === "review"));
    // The Review tab says the workflow takes the task on.
    await ui.run([`goto /p/${project.id}/settings/review`, "wait [data-testid=review-workflows-note]"]);
  });
});

test("an agent step's input-only switch is saved", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Summarise, then a skill']",
      "wait from the steps before",
      "click [data-node=skill]",
      "click Work only on what the steps before it wrote",
      "click [data-node=summary]",
      "click Work only on what the steps before it wrote",
      "click Create workflow",
      "gone [role=dialog]",
    ]);
    const w = await workflow("Summarise, then a skill");
    const n = Object.fromEntries(w.graph.nodes.map((n) => [n.id, n]));
    // The preset's skill step had it on, and the summary off: each was switched.
    assert.deepEqual([n.summary.input_only, "input_only" in n.skill], [true, false]);
  });
});
