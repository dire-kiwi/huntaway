import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Actor } from "../platform/Changes.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Workflows } from "./Workflows.ts"
import { agentFinishes, engine, latest, make, onBoard, PROJECT, runsOf, setProject, setTask, settle, states, task, TASK, workable } from "./tests/board.ts"

// What starts a run (huntaway's integrations/workflows/triggers.test.ts): a task entering a column, its agent finishing,
// and what holds a task for its run. The task moves through `Tasks`, and the reactor starts what its new column starts.

const move = (status: "todo" | "in_review" | "in_progress" | "backlog") =>
  Effect.gen(function* () {
    yield* (yield* Tasks).update(TASK, { status }, Actor.user)
    yield* settle
  })

describe("what starts a run", () => {
  it.effect("a workflow starts when its task enters its column, and not when it's off", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "backlog" })
        // Entering In review moves the task to To do, which a second workflow (off) would move to Backlog.
        const first = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "status", status: "in_review" },
            { id: "m", kind: "set_status", status: "todo" },
          ],
          edges: [{ from: "t", port: "out", to: "m" }],
        })
        const second = yield* make(
          {
            nodes: [
              { id: "t", kind: "trigger", on: "status", status: "todo" },
              { id: "m", kind: "set_status", status: "backlog" },
            ],
            edges: [{ from: "t", port: "out", to: "m" }],
          },
          "Second",
          false,
        )
        yield* move("in_review")
        assert.strictEqual((yield* task()).status, "todo")
        assert.strictEqual((yield* latest(first)).state, "done")
        assert.deepStrictEqual(yield* runsOf(second), [])
        // Moving it back into In review by hand starts the first again.
        yield* move("in_review")
        assert.strictEqual((yield* task()).status, "todo")
        assert.strictEqual((yield* runsOf(first)).length, 2)
        // Deleting a workflow takes its runs with it.
        yield* (yield* Workflows).delete(first.id)
        assert.deepStrictEqual(yield* runsOf(first), [])
      }),
    ),
  )

  it.effect("a finished workflow holds the task in progress and moves it on", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
        // Without one, the agent's finished run goes to In review.
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "in_review")
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "finished" },
            { id: "c", kind: "condition", check: "label", value: "plan" },
            { id: "m", kind: "set_status", status: "backlog" },
          ],
          edges: [
            { from: "t", port: "out", to: "c" },
            { from: "c", port: "no", to: "m" },
          ],
        })
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "backlog")
        const run = yield* latest(w)
        assert.deepStrictEqual([run.source, run.state, states(run)], ["finished", "done", { t: "done:done", c: "done:no", m: "done" }])
        // Off, it leaves the agent's run to go to In review as before.
        yield* (yield* Workflows).update(w.id, { enabled: false })
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "in_review")
        // Its In progress node doesn't start when the task enters In progress, only when its agent's work is done.
        yield* (yield* Workflows).update(w.id, { enabled: true })
        yield* setTask(TASK, { status: "todo" })
        yield* move("in_progress")
        assert.strictEqual((yield* latest(w)).id, run.id)
      }),
    ),
  )

  it.effect("a finished run that leaves the task where it was moves it on", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
        // An agent step that can't start (no ia-shim here), with nothing after its failure: Needs attention, saying why.
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "finished" },
            { id: "a", kind: "agent", name: "Notes" },
            { id: "m", kind: "set_status", status: "in_review" },
          ],
          edges: [
            { from: "t", port: "out", to: "a" },
            { from: "a", port: "done", to: "m" },
          ],
        })
        yield* agentFinishes()
        let t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.isTrue((t.attention_reason ?? "").startsWith('The workflow "Review" failed at Notes: '), t.attention_reason ?? "")
        // One that ends without a move, and without failing: In review, as without it.
        yield* (yield* Workflows).update(w.id, {
          graph: {
            nodes: [
              { id: "t", kind: "column", status: "in_progress", prompt: "", x: 0, y: 0 },
              { id: "c", kind: "condition", check: "has_pr", x: 0, y: 0 },
            ],
            edges: [{ from: "t", port: "done", to: "c" }],
          },
        })
        yield* agentFinishes()
        t = yield* task()
        assert.deepStrictEqual([t.status, t.attention_reason], ["in_review", null])
      }),
    ),
  )

  it.effect("a project that doesn't use workflows keeps the board's handling and runs them only by hand", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "backlog" })
        yield* setProject({ use_workflows: 0 })
        const w = yield* make({
          nodes: [
            { id: "ci", kind: "column", status: "in_review", prompt: "Check it." },
            { id: "out", kind: "column", status: "backlog" },
          ],
          edges: [{ from: "ci", port: "done", to: "out" }],
        })
        const facts = (yield* engine).facts
        const t = yield* task()
        assert.deepStrictEqual([yield* facts.mergeInstructions(t), yield* facts.boardOpensPr(t), yield* facts.finishDue(t)], [null, false, null])
        // Entering a column starts nothing.
        yield* move("todo")
        yield* move("in_review")
        assert.deepStrictEqual(yield* runsOf(w), [])
        // By hand it runs.
        const run = yield* (yield* engine).run(w.id, TASK)
        assert.strictEqual(run.source, "manual")
        assert.strictEqual(run.workflow_name, "Review")
      }),
    ),
  )

  it.effect("a task held for a run that doesn't start goes to review", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress" },
            { id: "c", kind: "condition", check: "has_pr" },
          ],
          edges: [{ from: "work", port: "done", to: "c" }],
        })
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "in_review")
        assert.strictEqual((yield* runsOf(w)).length, 1)
        // Held again for the same run of the agent (as when a restart settles its column again): it doesn't run twice.
        yield* setTask(TASK, { status: "in_progress" })
        yield* (yield* engine).workDone({ _tag: "WorkflowWorkDone", task: TASK, due: { workflow_id: w.id, node: "work", run_id: null }, mergeFinished: false })
        yield* settle
        assert.strictEqual((yield* runsOf(w)).length, 1)
        assert.strictEqual((yield* task()).status, "in_review")
      }),
    ),
  )

  it.effect("an unfinished todo list holds the task from its workflow", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress", done_when: "finish" },
            { id: "out", kind: "column", status: "backlog" },
          ],
          edges: [{ from: "work", port: "done", to: "out" }],
        })
        // Its agent is asked to finish the list (that run fails to launch here), and the workflow doesn't start.
        yield* agentFinishes({ finished: true, todos: [{ text: "Add tests", status: "pending" }] })
        assert.deepStrictEqual(yield* runsOf(w), [])
        // Complete, it goes on.
        yield* agentFinishes({ finished: true, todos: [] })
        assert.strictEqual((yield* task()).status, "backlog")
        assert.strictEqual(PROJECT, (yield* task()).project_id)
      }),
    ),
  )
})
