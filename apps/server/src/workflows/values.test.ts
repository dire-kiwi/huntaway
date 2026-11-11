import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { WorkflowId, WorkflowRunId } from "@huntaway/contracts"
import type { WorkflowGraph, WorkflowNodeRun } from "@huntaway/contracts"
import { render } from "./graph.ts"
import { readGraph } from "./read.ts"
import { engine, latest, make, onBoard, runByHand, sent, setTask, task, TASK, workable } from "./tests/board.ts"
import { Workflows } from "./Workflows.ts"

// Values (huntaway's integrations/workflows/values.test.ts): templates, and what data wires give the inputs they go
// into. Templates are `graph.ts`'s `render`, tested as it is; wired prompts are read through the engine's facts and runs.

/** A graph as an agent gives it, read as the board keeps it. */
const graphOf = (g: unknown): WorkflowGraph => {
  const read = readGraph(g)
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure)
}

/** Review, then fix rounds or a summary (the old tests' `review_graph`). */
const REVIEW = {
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

/** A run of `graph` as the tests make it by hand, with `nodes`. */
const bareRun = (graph: WorkflowGraph, nodes: Readonly<Record<string, WorkflowNodeRun>>, head: string | null = null) => ({
  id: WorkflowRunId.make("r"),
  workflow_id: WorkflowId.make("w"),
  graph,
  nodes,
  head,
})

/** Prompts built from wires: In progress's from the task, the project's start prompt, a rule, a switch and the last review. */
const wired = (next: boolean) => ({
  nodes: [
    { id: "work", kind: "column", status: "in_progress" },
    { id: "review", kind: "column", status: "in_review" },
    { id: "reviewer", kind: "agent", name: "Reviewer", output: "verdict" },
    { id: "task", kind: "task" },
    { id: "rules", kind: "text", text: "Rules for {{task.key}}." },
    { id: "base", kind: "project_prompt", which: "start" },
    { id: "plan", kind: "switch", check: "label", value: "plan" },
    { id: "planned", kind: "text", text: "Follow the plan." },
    { id: "join", kind: "join", separator: "\\n", count: 3 },
    { id: "compose", kind: "compose", template: "# {{title}}\n\n{{body}}\n\nFix: {{issues}}{{note}}" },
  ],
  edges: [
    { from: "work", port: "done", to: "review" },
    { from: "review", port: "done", to: "reviewer" },
    { from: "task", port: "title", to: "compose", input: "title" },
    { from: "base", port: "text", to: "join", input: "in1" },
    { from: "rules", port: "text", to: "join", input: "in2" },
    { from: "plan", port: "text", to: "join", input: "in3" },
    { from: "planned", port: "text", to: "plan", input: "yes" },
    { from: "join", port: "text", to: "compose", input: "body" },
    { from: "reviewer", port: "issues", to: "compose", input: "issues" },
    ...(next ? [{ from: "work", port: "next", to: "compose", input: "note" }] : []),
    { from: "compose", port: "text", to: "work", input: "prompt" },
  ],
})

const TASK_FIELDS = { title: "Fix the thing", description: "Make it work.", branch: "ia/x-1", pr_url: null, labels: [], task_type: null }

describe("values", () => {
  it("templates take the task and earlier steps", () => {
    const run = bareRun(graphOf(REVIEW), { review: { state: "done", port: "issues", text: "Nearly.", issues: ["a bug", "another"] } }, "abc")
    const out = render("{{task.key}} {{ task.title }} on {{branch}} at {{commit}}: {{review.text}}\n{{issues}} {{nope}} {{unclosed", {
      task: TASK_FIELDS,
      key: "X-1",
      workflow: "W",
      run,
    })
    assert.strictEqual(out, "X-1 Fix the thing on ia/x-1 at abc: Nearly.\n1. a bug\n\n2. another {{nope}} {{unclosed")
  })

  it("an A/B test's path is a value and a template", () => {
    const g = graphOf({
      nodes: [
        { id: "t", kind: "trigger", on: "manual" },
        { id: "ab", kind: "split", weights: [1, 1] },
      ],
      edges: [],
    })
    const run = bareRun(g, { ab: { state: "done", port: "b", text: "B" }, t: { state: "done", port: "out" } })
    const out = render("path {{ab.path}}, {{t.path}}", { task: { ...TASK_FIELDS, title: "T", description: "", branch: null }, key: "X-1", workflow: "W", run })
    assert.strictEqual(out, "path B, {{t.path}}", "only an A/B test has a path")
  })

  it.effect("a prompt built from wires takes the task, the last review, and the note where it's put", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        yield* setTask(TASK, { labels: ["plan"] })
        const w = yield* make(wired(false))
        // The last review found an issue.
        yield* runByHand(
          w,
          { review: { state: "done", port: "done", start: true }, reviewer: { state: "done", port: "issues", issues: ["It crashes."] } },
          { state: "done" },
        )
        const facts = (yield* engine).facts
        const start = Effect.flatMap(task(), (t) => facts.startInstructions(t, { start_prompt: null }))
        const note = "When you're done, end your turn with a summary of what you did. The board then moves the task to In review."
        // {{note}} isn't wired: unwired, a name with no value of the template's own is left as it is.
        assert.strictEqual(
          yield* start,
          `# Fix the thing\n\nStart working on this task.\nRules for X-1.\nFollow the plan.\n\nFix: 1. It crashes.{{note}}\n\n${note}`,
        )
        // With `next` wired, the note is where it's put, and only there.
        yield* (yield* Workflows).update(w.id, { graph: graphOf(wired(true)) })
        assert.strictEqual(yield* start, `# Fix the thing\n\nStart working on this task.\nRules for X-1.\nFollow the plan.\n\nFix: 1. It crashes.${note}`)
        // Without the label, the switch gives its no, which isn't wired: that line goes.
        yield* setTask(TASK, { labels: [] })
        assert.notInclude((yield* start) ?? "", "Follow the plan.")
      }),
    ),
  )

  it.effect("a send and a pull request take their wired text", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        yield* setTask(TASK, { session_id: "sess" })
        const w = yield* make({
          nodes: [
            { id: "start", kind: "trigger", on: "manual" },
            { id: "send", kind: "send_to_task", message: "unused", max_rounds: 2 },
            { id: "msg", kind: "compose", template: "Hello {{who}}, about {{task.key}}." },
            { id: "who", kind: "task" },
          ],
          edges: [
            { from: "start", port: "out", to: "send" },
            { from: "who", port: "title", to: "msg", input: "who" },
            { from: "msg", port: "text", to: "send", input: "message" },
          ],
        })
        const run = yield* (yield* engine).run(w.id, TASK)
        // Data nodes take no part in the run, which ends as it would without them.
        assert.deepStrictEqual([run.state, Object.keys(run.nodes).toSorted()], ["done", ["send", "start"]])
        assert.strictEqual((yield* sent()).at(-1), "Hello Fix the thing, about X-1.")
        assert.strictEqual((yield* latest(w)).nodes["send"]?.port, "sent")
      }),
    ),
  )
})
