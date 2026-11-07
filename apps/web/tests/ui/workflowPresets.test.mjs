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

// HA-276: a workflow whose In progress column, once the agent is done, opens the pull request and moves the task to In review.
test("the pull request preset saves its columns and its pull request step", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Open a PR when done']",
      "wait Pushes the branch",
      "click [data-node=pr]",
      "click Open it as a draft",
      "click Create workflow",
      "gone [role=dialog]",
      "wait In progress → In review → Needs attention · pull request",
    ]);
    const w = await workflow("Open a pull request, then review");
    const kinds = Object.fromEntries(w.graph.nodes.map((n) => [n.id, n]));
    assert.deepEqual([kinds.start.kind, kinds.start.status, kinds.review.kind, kinds.review.status], ["column", "in_progress", "column", "in_review"]);
    assert.deepEqual([kinds.pr.kind, kinds.pr.draft], ["open_pr", true]);
    assert.ok(w.graph.edges.some((e) => e.from === "pr" && e.port === "opened" && e.to === "review"));
    // The Review tab says the workflow takes the task on.
    await ui.run([`goto /p/${project.id}/settings/review`, "wait [data-testid=review-workflows-note]"]);
  });
});

// HA-276: a column's prompt, when its work is done, and what the board adds to the prompt about what comes next.
test("a column step's prompt and done signal are saved, with what's added to the prompt", async () => {
  // In progress belongs to one workflow that's on: not the first test's.
  const { workflows } = await server.api("GET", `/projects/${project.id}/workflows`);
  for (const w of workflows) await server.api("DELETE", `/workflows/${w.id}`);
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Work, PR and review']",
      "wait Pushes the branch",
      "click [data-node=work]",
      "click [data-testid=workflow-inspector] textarea",
      "type Build it, with tests.",
      "wait [data-testid=column-done-note]",
    ]);
    const note = await ui.page.textContent("[data-testid=column-done-note]");
    assert.ok(note.includes("The board then pushes your branch and opens its pull request (so don't open one yourself) and moves the task to In review"), note);
    await ui.page.selectOption("[data-testid=workflow-inspector] select >> nth=1", "finish");
    await ui.run(["wait call `finish_work`", "click Create workflow", "gone [role=dialog]"]);
    const w = await workflow("Work, pull request and review");
    const work = w.graph.nodes.find((n) => n.id === "work");
    assert.deepEqual([work.kind, work.status, work.prompt, work.done_when], ["column", "in_progress", "Build it, with tests.", "finish"]);
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

// Review of HA-276: lines back into In progress give the agent its work a limited number of times in a row, which
// In progress's step sets once a line goes into it.
test("In progress's rounds are set once a line goes back into it", async () => {
  const { workflows } = await server.api("GET", `/projects/${project.id}/workflows`);
  for (const w of workflows) await server.api("DELETE", `/workflows/${w.id}`);
  const w = await server.api("POST", `/projects/${project.id}/workflows`, {
    name: "Loop back",
    graph: {
      nodes: [
        { id: "work", kind: "column", status: "in_progress", x: 0, y: 0 },
        { id: "review", kind: "column", status: "in_review", x: 300, y: 0 },
        { id: "c", kind: "condition", check: "has_pr", x: 600, y: 0 },
      ],
      edges: [
        { from: "work", port: "done", to: "review" },
        { from: "review", port: "done", to: "c" },
        { from: "c", port: "no", to: "work" },
      ],
    },
  });
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name=/^Edit$/]",
      "wait [data-node=work]",
      "click [data-node=work]",
      "wait Rounds",
      "click [data-testid=workflow-inspector] input[type=number]",
      "type 5",
      "click Save",
      "gone [role=dialog]",
    ]);
  });
  const saved = await server.api("GET", `/workflows/${w.id}`);
  assert.equal(saved.graph.nodes.find((n) => n.id === "work").max_rounds, 5);
});

// A template's {{…}} values are listed as one is typed: the task's, and each step's output by its id.
test("a template's values are completed as they're typed", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Work, PR and review']",
      "wait Pushes the branch",
      "click [data-node=fix]",
      "click [data-testid=workflow-inspector] textarea",
      "type Fix {{iss",
      "wait role=option[name=/reviewer\\.issues/]",
      "press ArrowDown",
      "press Enter",
      "gone [role=listbox]",
      "press Space",
      "type for {{ task.ti",
      "wait role=option[name=/task\\.title/]",
      "press Tab",
      "gone [role=listbox]",
      "press Space",
      "type {{",
      "wait [role=listbox]",
      "press Escape",
      "gone [role=listbox]",
      // Escape closed the list, not the dialog.
      "wait Pushes the branch",
    ]);
    const text = await ui.page.inputValue("[data-testid=workflow-inspector] textarea");
    assert.equal(text, "Fix {{reviewer.issues}} for {{task.title}} {{");
  });
});
