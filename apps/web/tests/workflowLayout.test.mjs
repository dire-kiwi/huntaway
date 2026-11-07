import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { arrange } from "../src/workflowLayout.ts";

const DATA = new Set(["text", "task", "compose"]);
const PORTS = { column: ["done"], condition: ["yes", "no"], agent: ["pass", "issues"], open_pr: ["opened", "failed"], send_to_task: ["exhausted"] };
// Nodes 100 high, an outcome's line leaving 20 apart from the top, as the editor's rows are.
const geo = {
  width: 180,
  height: () => 100,
  fromY: (n, e) => 30 + 20 * Math.max(0, (PORTS[n.kind] ?? []).indexOf(e.port)),
  toY: () => 15,
  isData: (n) => DATA.has(n.kind),
};

const node = (id, kind, x, y) => ({ id, kind, x, y });
// Drawn in a heap, with the no branch above the yes one and a loop back to the start.
const graph = {
  nodes: [
    node("fix", "send_to_task", 0, 0),
    node("review", "agent", 0, 0),
    { ...node("work", "column", 500, 500), status: "in_progress" },
    node("commits", "condition", 0, 0),
    { ...node("inreview", "column", 0, 10), status: "in_review" },
    node("pr", "open_pr", 0, 20),
    node("rules", "text", 900, 900),
  ],
  edges: [
    { from: "work", port: "done", to: "commits" },
    { from: "commits", port: "no", to: "inreview" },
    { from: "commits", port: "yes", to: "pr" },
    { from: "pr", port: "opened", to: "inreview" },
    { from: "inreview", port: "done", to: "review" },
    { from: "review", port: "issues", to: "fix" },
    // Back round to the start.
    { from: "fix", port: "exhausted", to: "work" },
    { from: "rules", port: "text", to: "review", input: "prompt" },
  ],
};

const at = (g) => Object.fromEntries(g.nodes.map((n) => [n.id, n]));

test("steps go in columns along the way a run goes, a line back round left out", () => {
  const p = at(arrange(graph, geo));
  const order = ["work", "commits", "pr", "inreview", "review", "fix"];
  for (let i = 1; i < order.length; i++) assert.ok(p[order[i - 1]].x < p[order[i]].x, `${order[i - 1]} before ${order[i]}`);
  // In review comes after the pull request, which is after the check: three columns on.
  assert.equal(p.inreview.x - p.commits.x, 2 * (180 + 90));
});

test("a value goes in the column before the step it goes into", () => {
  const p = at(arrange(graph, geo));
  assert.equal(p.review.x - p.rules.x, 180 + 90);
});

test("no two nodes overlap, and the top one is at the top", () => {
  const g = arrange(graph, geo);
  for (const a of g.nodes) for (const b of g.nodes) if (a !== b && a.x === b.x) assert.ok(a.y + 100 <= b.y || b.y + 100 <= a.y, `${a.id} and ${b.id} overlap`);
  assert.equal(Math.min(...g.nodes.map((n) => n.y)), 20);
});

test("branches are ordered as their outcomes are, so their lines don't cross", () => {
  const g = {
    nodes: [node("c", "condition", 0, 0), node("b", "column", 0, 0), node("a", "column", 0, 200)],
    // a is drawn below b, but comes off yes, above no.
    edges: [
      { from: "c", port: "yes", to: "a" },
      { from: "c", port: "no", to: "b" },
    ],
  };
  const p = at(arrange(g, geo));
  assert.ok(p.a.y < p.b.y);
});

test("a graph with no edges, or none at all, is laid out without failing", () => {
  assert.deepEqual(arrange({ nodes: [], edges: [] }, geo), { nodes: [], edges: [] });
  const p = at(arrange({ nodes: [node("a", "column", 300, 300), node("t", "task", 0, 0)], edges: [] }, geo));
  assert.equal(p.a.x, 20);
  assert.equal(p.t.x, 20);
});
