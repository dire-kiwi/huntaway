import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import type { WorkflowGraph } from "@huntaway/contracts"
import { checkGraph } from "./check.ts"
import { readGraph } from "./read.ts"

// Checking a graph (huntaway's integrations/workflows/check.test.ts): what a workflow's nodes, edges and data wires may
// be, and how older graphs are read. Pure: a graph as an agent gives it is read (`readGraph`), then checked against the
// project's agent configs (`checkGraph`). The case of a column clashing with another workflow's is `Workflows.test.ts`'s.

/** A graph as given, read and checked: the graph, or why it's refused. */
const checked = (g: unknown, configs: ReadonlyArray<string> = []): Result.Result<WorkflowGraph, string> => {
  const read = readGraph(g)
  return Result.isFailure(read) ? Result.fail(`graph: ${read.failure}`) : checkGraph(read.success, configs)
}

const ok = (g: unknown, configs: ReadonlyArray<string> = []): WorkflowGraph => {
  const r = checked(g, configs)
  if (Result.isFailure(r)) throw new Error(r.failure)
  return r.success
}

const bad = (g: unknown, what: string) => {
  const r = checked(g)
  assert.isTrue(Result.isFailure(r), `refused: ${what}`)
  if (Result.isFailure(r)) assert.include(r.failure, what)
}

/** Review, then fix rounds or a summary, as the old tests' `review_graph`. */
export const reviewGraph = {
  nodes: [
    { id: "start", kind: "trigger", on: "status", status: "in_review" },
    { id: "changed", kind: "condition", check: "changed" },
    { id: "review", kind: "agent", name: "Reviewer", output: "verdict", tab: "Review" },
    { id: "fix", kind: "send_to_task", max_rounds: 1 },
    { id: "summary", kind: "agent", name: "Summary", output: "text", tab: "Summary", prompt: "Summarise {{task.key}}." },
  ],
  edges: [
    { from: "start", port: "out", to: "changed" },
    { from: "changed", port: "yes", to: "review" },
    { from: "review", port: "issues", to: "fix" },
    { from: "review", port: "pass", to: "summary" },
  ],
}

/** A manual start into A/B test `ab` with `paths` paths, each into an agent step. */
const abGraph = (split: Record<string, unknown>, paths: number) => ({
  nodes: [
    { id: "t", kind: "trigger", on: "manual" },
    { id: "ab", kind: "split", ...split },
    ...Array.from({ length: paths }, (_, i) => ({ id: `s${i}`, kind: "agent", name: `S${i}` })),
  ],
  edges: [{ from: "t", port: "out", to: "ab" }, ...Array.from({ length: paths }, (_, i) => ({ from: "ab", port: "abcdefgh"[i], to: `s${i}` }))],
})

const manual = { id: "a", kind: "trigger", on: "manual" }

/** A manual start into agent step `a` with settings `o`. */
const graph = (o: Record<string, unknown>) => ({
  nodes: [
    { id: "t", kind: "trigger", on: "manual" },
    { id: "a", kind: "agent", name: "A", output: "text", ...o },
  ],
  edges: [{ from: "t", port: "out", to: "a" }],
})

/** In progress with settings `n`, then a check. */
const inProgress = (n: Record<string, unknown>) => ({
  nodes: [
    { id: "work", kind: "column", status: "in_progress", ...n },
    { id: "c", kind: "condition", check: "has_pr" },
  ],
  edges: [{ from: "work", port: "done", to: "c" }],
})

describe("checking a graph", () => {
  it("a graph needs a start, real ports and no loops", () => {
    ok(reviewGraph)
    bad({ nodes: [], edges: [] }, "needs a column node")
    bad({ nodes: [{ id: "a", kind: "trigger", on: "status" }], edges: [] }, "needs its column")
    bad({ nodes: [manual, { id: "b", kind: "trigger", on: "manual" }], edges: [] }, "one start")
    bad({ nodes: [manual, { id: "b", kind: "set_status", status: "todo" }], edges: [{ from: "a", port: "yes", to: "b" }] }, "has no port yes")
    bad({ nodes: [manual, { id: "b", kind: "set_status", status: "todo" }], edges: [{ from: "b", port: "out", to: "a" }] }, "into the start")
    bad(
      {
        nodes: [manual, { id: "b", kind: "agent", name: "B" }, { id: "c", kind: "agent", name: "C" }],
        edges: [
          { from: "a", port: "out", to: "b" },
          { from: "b", port: "done", to: "c" },
          { from: "c", port: "done", to: "b" },
        ],
      },
      "loop through b",
    )
    // Round again through a column is no loop: the path ends there, and the next run starts from it.
    ok({
      nodes: [
        { id: "w", kind: "column", status: "in_progress" },
        { id: "r", kind: "agent", name: "R", output: "verdict" },
        { id: "v", kind: "column", status: "in_review" },
      ],
      edges: [
        { from: "w", port: "done", to: "v" },
        { from: "v", port: "done", to: "r" },
        { from: "r", port: "issues", to: "w" },
      ],
    })
    bad({ nodes: [manual, { id: "b", kind: "column", status: "nowhere" }], edges: [] }, "unknown column")
    bad({ nodes: [manual, { id: "b", kind: "column", status: "done", prompt: "Hi" }], edges: [] }, "no work in Done")
    bad({ nodes: [manual, { id: "b", kind: "column", status: "needs_attention", prompt: "Hi" }], edges: [] }, "waits for the user")
    bad({ nodes: [manual, { id: "b", kind: "column", status: "done" }], edges: [{ from: "a", port: "out", to: "b" }] }, "into Done")
    bad(
      {
        nodes: [
          { id: "b", kind: "column", status: "in_review" },
          { id: "c", kind: "set_status", status: "in_review" },
        ],
        edges: [],
      },
      "two nodes are the column In review",
    )
    bad({ nodes: [{ id: "b", kind: "column", status: "ready_for_merge", done_when: "finish" }], edges: [] }, "when the task is merged")
    bad({ nodes: [manual, { id: "b", kind: "agent", name: " " }], edges: [] }, "needs a name")
    bad({ nodes: [manual, { id: "b", kind: "agent", name: "R", claude_config_id: "nope" }], edges: [] }, "agent configs")
    bad({ nodes: [manual, { id: "a", kind: "set_status", status: "todo" }], edges: [] }, "two nodes")
    // What the reader refuses.
    bad({ nodes: [manual, { id: "b", kind: "teleport" }], edges: [] }, "graph: ")
    bad({ nodes: [manual, { id: "b", kind: "set_status" }], edges: [] }, "graph: ")
    // Blank settings are dropped, and a manual trigger keeps no column.
    const g = ok({
      nodes: [
        { id: "a", kind: "trigger", on: "manual", status: "todo" },
        { id: "b", kind: "agent", name: " R ", model: " ", skills: ["/tldr", ""], disabled_mcp_servers: [" docs ", "docs", ""], label: "Not a value" },
        { id: "c", kind: "text", text: "Hi", label: " Rules " },
        { id: "d", kind: "agent", name: "S", disabled_mcp_servers: [" "] },
      ],
      edges: [],
    })
    assert.deepStrictEqual(g.nodes[0], { id: "a", kind: "trigger", on: "manual", x: 0, y: 0 })
    const b = g.nodes[1]
    assert.deepStrictEqual(b?.kind === "agent" ? [b.name, b.model, b.skills, b.disabled_mcp_servers] : null, ["R", undefined, ["tldr"], ["docs"]])
    assert.isFalse(b !== undefined && "model" in b, "a blank model isn't kept")
    // A value's label is kept, trimmed; a step has its name instead.
    assert.isFalse(b !== undefined && "label" in b)
    assert.strictEqual(g.nodes[2]?.label, "Rules")
    assert.isFalse(g.nodes[3] !== undefined && "disabled_mcp_servers" in g.nodes[3])
    bad({ nodes: [manual, { id: "c", kind: "text", text: "", label: "x".repeat(61) }], edges: [] }, "name is longer than 60")
  })

  it("an agent step's effort and model are checked", () => {
    for (const wrong of [{ effort: "extreme" }, { model: "--dangerously-skip-permissions" }, { model: "opus plus" }, { model: "x".repeat(101) }]) {
      assert.isTrue(Result.isFailure(checked(graph(wrong))), Object.values(wrong).join())
    }
    const a = ok(graph({ effort: " high ", model: " claude-opus-5-5[1m] " })).nodes.find((n) => n.id === "a")
    assert.deepStrictEqual(a?.kind === "agent" ? [a.effort, a.model] : null, ["high", "claude-opus-5-5[1m]"])
    const blank = ok(graph({ effort: " ", model: "" })).nodes.find((n) => n.id === "a")
    assert.isFalse(blank !== undefined && ("effort" in blank || "model" in blank))
    // One of the project's configs is taken.
    assert.isTrue(Result.isSuccess(checked(graph({ claude_config_id: "c1" }), ["c1"])))
  })

  it("the new nodes are checked", () => {
    const g = ok({
      nodes: [
        { id: "t", kind: "trigger", on: "finished", status: "in_review" },
        { id: "pr", kind: "open_pr", title: " {{task.key}} ", draft: true },
        { id: "a", kind: "agent", name: "A", input_only: true },
      ],
      edges: [
        { from: "t", port: "out", to: "pr" },
        { from: "pr", port: "opened", to: "a" },
        { from: "pr", port: "exists", to: "a" },
      ],
    })
    // A start on the agent finishing, from before column nodes, is In progress's node, and its `out` is `done`.
    assert.deepStrictEqual(g.nodes[0], { id: "t", kind: "column", status: "in_progress", prompt: "", x: 0, y: 0 })
    assert.deepStrictEqual(g.edges[0], { from: "t", port: "done", to: "pr" })
    assert.deepStrictEqual(g.nodes[1], { id: "pr", kind: "open_pr", title: "{{task.key}}", body: "", draft: true, x: 0, y: 0 })
    assert.strictEqual(g.nodes[2]?.kind === "agent" ? g.nodes[2].input_only : null, true)
    const plain = ok({ nodes: [manual, { id: "b", kind: "agent", name: "A" }], edges: [] })
    assert.isFalse(plain.nodes[1] !== undefined && "input_only" in plain.nodes[1])
    assert.isTrue(Result.isFailure(checked({ nodes: [manual, { id: "pr", kind: "open_pr" }], edges: [{ from: "pr", port: "out", to: "a" }] })))
  })

  it("old starts and moves are read as column nodes", () => {
    const g = readGraph({
      nodes: [
        { id: "t", kind: "trigger", on: "status", status: "in_review" },
        { id: "m", kind: "set_status", status: "needs_attention" },
        { id: "h", kind: "trigger", on: "manual" },
      ],
      edges: [
        { from: "t", port: "out", to: "m" },
        { from: "h", port: "out", to: "m" },
      ],
    })
    assert.isTrue(Result.isSuccess(g))
    if (Result.isFailure(g)) return
    assert.deepStrictEqual(
      g.success.nodes.map((n) => [n.kind, n.kind === "column" ? n.status : n.kind === "trigger" ? n.on : ""]),
      [
        ["column", "in_review"],
        ["column", "needs_attention"],
        ["trigger", "manual"],
      ],
    )
    assert.deepStrictEqual(
      g.success.edges.map((e) => e.port),
      ["done", "out"],
    )
  })

  it("data wires go from a value to an input, one each, and never round", () => {
    const nodes = [
      { id: "work", kind: "column", status: "in_progress" },
      { id: "t", kind: "text", text: "Use TDD." },
      { id: "u", kind: "text", text: "Be brief." },
      { id: "c", kind: "compose", template: "{{a}} {{b}}" },
      { id: "d", kind: "compose", template: "{{x}}" },
    ]
    ok({
      nodes,
      edges: [
        { from: "t", port: "text", to: "c", input: "a" },
        { from: "u", port: "text", to: "c", input: "b" },
        { from: "c", port: "text", to: "work", input: "prompt" },
      ],
    })
    bad({ nodes, edges: [{ from: "t", port: "nope", to: "c", input: "a" }] }, "gives no value nope")
    bad({ nodes, edges: [{ from: "t", port: "text", to: "c", input: "zz" }] }, "has no input zz")
    bad(
      {
        nodes,
        edges: [
          { from: "t", port: "text", to: "c", input: "a" },
          { from: "u", port: "text", to: "c", input: "a" },
        ],
      },
      "two wires",
    )
    bad({ nodes, edges: [{ from: "work", port: "done", to: "t" }] }, "gives values, so no run goes into it")
    bad({ nodes, edges: [{ from: "t", port: "done", to: "work" }] }, "has no port done")
    bad(
      {
        nodes,
        edges: [
          { from: "c", port: "text", to: "d", input: "x" },
          { from: "d", port: "text", to: "c", input: "a" },
        ],
      },
      "values go round in a loop",
    )
    // A step's value back into a step before it is no loop: it's read from its run, or an earlier one.
    ok({
      nodes: [
        { id: "work", kind: "column", status: "in_progress" },
        { id: "r", kind: "agent", name: "R", output: "verdict" },
      ],
      edges: [
        { from: "work", port: "done", to: "r" },
        { from: "r", port: "issues", to: "work", input: "prompt" },
      ],
    })
  })

  it("an In progress node's max_rounds is checked", () => {
    const five = ok(inProgress({ max_rounds: 5 })).nodes[0]
    assert.strictEqual(five?.kind === "column" ? five.max_rounds : null, 5)
    bad(inProgress({ max_rounds: 0 }), "1 to 20 times")
    bad(inProgress({ max_rounds: 21 }), "1 to 20 times")
    const review = ok({ nodes: [{ id: "r", kind: "column", status: "in_review", max_rounds: 5 }], edges: [] }).nodes[0]
    assert.isFalse(review !== undefined && "max_rounds" in review)
  })

  it("an A/B test's paths and weights are checked", () => {
    // Two even paths without weights.
    const g = ok({ nodes: [manual, { id: "ab", kind: "split" }], edges: [] })
    assert.deepStrictEqual(g.nodes[1], { id: "ab", kind: "split", weights: [50, 50], x: 0, y: 0 })
    ok(abGraph({ weights: [1, 0, 3], each_run: true }, 3))
    const wrong = (split: Record<string, unknown>, what: string, paths = 2) => bad(abGraph(split, paths), what)
    wrong({ weights: [1] }, "2 to 8 paths", 1)
    wrong({ weights: [1, 1, 1, 1, 1, 1, 1, 1, 1] }, "2 to 8 paths", 8)
    wrong({ weights: [1, -1] }, "weights must be 0 to 1000")
    wrong({ weights: [1, 1001] }, "weights must be 0 to 1000")
    wrong({ weights: [0, 0] }, "a weight above 0")
    wrong({ weights: [1, "2"] }, "graph: ")
    // A path it doesn't have.
    wrong({ weights: [1, 1] }, "has no port c", 3)
  })
})
