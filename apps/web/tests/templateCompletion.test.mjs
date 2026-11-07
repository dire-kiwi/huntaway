import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { templateMatches, templatePick, templateTyped, templateValues } from "../src/templateCompletion.ts";

const graph = {
  nodes: [
    { id: "start", kind: "column", status: "in_progress", prompt: "", x: 0, y: 0 },
    { id: "reviewer", kind: "agent", name: "Review", output: "verdict", prompt: "", x: 0, y: 0 },
    { id: "notes", kind: "agent", name: "Notes", output: "text", prompt: "", x: 0, y: 0 },
    { id: "pr", kind: "open_pr", title: "", body: "", x: 0, y: 0 },
  ],
  edges: [],
};

test("a template can use the task's values and each step's output", () => {
  const names = templateValues(graph).map((v) => v.name);
  for (const n of ["task.key", "task.title", "issues", "reviewer.text", "reviewer.issues", "reviewer.verdict", "notes.text", "pr.text"])
    assert.ok(names.includes(n), n);
  assert.ok(!names.includes("notes.verdict"));
  assert.ok(!names.some((n) => n.startsWith("start.")));
  // Not a step's own output, in its own template.
  assert.ok(!templateValues(graph, "pr").some((v) => v.name === "pr.text"));
});

test("the value being typed is the one after the last {{ before the caret", () => {
  assert.deepEqual(templateTyped("Fix {{", 6), { start: 4, query: "" });
  assert.deepEqual(templateTyped("Fix {{ task.ti", 14), { start: 4, query: "task.ti" });
  assert.deepEqual(templateTyped("{{task.key}}: {{rev", 19), { start: 14, query: "rev" });
  assert.equal(templateTyped("{{task.key}} done", 17), null);
  assert.equal(templateTyped("{{task key", 10), null);
  assert.equal(templateTyped("no braces", 9), null);
});

test("values starting with what's typed come first, then those containing it", () => {
  const names = templateMatches(templateValues(graph), "iss").map((v) => v.name);
  assert.deepEqual(names, ["issues", "reviewer.issues"]);
});

test("picking a value fills in the {{ being typed, and takes in a }} already there", () => {
  assert.deepEqual(templatePick("Fix {{ta and", 8, 4, "task.title"), { text: "Fix {{task.title}} and", caret: 18 });
  assert.deepEqual(templatePick("Fix {{ta}} and", 8, 4, "task.title"), { text: "Fix {{task.title}} and", caret: 18 });
  assert.deepEqual(templatePick("{{ta", 4, 0, "task.key"), { text: "{{task.key}}", caret: 12 });
});
