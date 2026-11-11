import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { WorkflowNodeRun } from "@huntaway/contracts"
import { fakeAgent } from "@huntaway/testing"
import { MergeGate } from "../merge/MergeGate.ts"
import { Actor } from "../platform/Changes.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Workflows } from "./Workflows.ts"
import {
  agentFinishes,
  engine,
  latest,
  make,
  onBoard,
  PROJECT,
  runByHand,
  runsOf,
  sent,
  setProject,
  setTask,
  settle,
  states,
  stepAgent,
  stepThread,
  task,
  TASK,
  workable,
} from "./tests/board.ts"

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
  // A merge approved or denied on its card didn't start the workflows of the column that moved the task to.
  it.effect("deciding a merge starts the workflows of the column it moves the task to", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "needs_attention", task: { merging: true, merge_approval: "pending" } })
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "status", status: "in_review" },
            { id: "c", kind: "condition", check: "has_pr" },
          ],
          edges: [{ from: "t", port: "out", to: "c" }],
        })
        // Its summary run has ended, and the card waits for the user's answer.
        assert.strictEqual((yield* (yield* MergeGate).decide(TASK, false)).status, "in_review")
        yield* settle
        assert.strictEqual((yield* latest(w)).state, "done")
      }),
    ),
  )

  it.effect("a stopped finished run moves the task on unless its agent started again", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
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
        // Started as its agent's finishing starts it, its step's agent working.
        const thread = yield* stepThread("notes", "Notes (Review) of X-1")
        yield* stepAgent(thread)
        const steps: Readonly<Record<string, WorkflowNodeRun>> = {
          t: { state: "done", port: "done", start: true },
          a: { state: "running", thread_id: thread, after_run: "" },
        }
        let run = yield* runByHand(w, steps, { source: "finished" })
        // Its agent starts again: the task is that run's, and stays where it is.
        const again = yield* fakeAgent({ task: TASK, kind: "prompt" })
        const e = yield* engine
        yield* e.supersede(TASK)
        yield* settle
        assert.strictEqual((yield* latest(w)).state, "stopped")
        assert.strictEqual((yield* task()).status, "in_progress")
        // Stopped by the user once that run has ended: Needs attention.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE runs SET status = 'exited' WHERE task_id = ${TASK}`.pipe(Effect.orDie)
        run = yield* runByHand(w, steps, { source: "finished", task_run: again.run.id })
        assert.deepStrictEqual(yield* e.stopTask(TASK), { stopped: true })
        yield* settle
        assert.strictEqual((yield* latest(w)).id, run.id)
        const t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.isTrue((t.attention_reason ?? "").startsWith('The workflow "Review" was stopped before it moved the task'), t.attention_reason ?? "")
      }),
    ),
  )

  // finish_work belongs to the run that called it, so the agent asked to finish its list after saying its work is done
  // is asked to say so again, in that run.
  it.effect("a task held for its todo list is asked to say its work is done again", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress" })
        yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress", done_when: "finish" },
            { id: "out", kind: "column", status: "backlog" },
          ],
          edges: [{ from: "work", port: "done", to: "out" }],
        })
        // It says its work is done with an item unfinished: it's held, and asked to finish the list, then to say so.
        yield* agentFinishes({ finished: true, todos: [{ text: "Add tests", status: "pending" }] })
        const asked = (yield* sent()).at(-1) ?? ""
        assert.isTrue(asked.startsWith("Your todo list still has unfinished items"), asked)
        assert.include(asked, "call `finish_work`")
        assert.include(asked, "The board then moves the task to Backlog")
        // That run's launch fails here; the agent's next run finishes the list and says so: the workflow takes it on.
        yield* agentFinishes({ finished: true, todos: [] })
        assert.strictEqual((yield* task()).status, "backlog")
      }),
    ),
  )

  // The same for a column other than In progress whose prompt waits for finish_work: the reminder ends with that
  // column's note, and the run that finishes the list and says so moves the task on.
  it.effect("a task held for its todo list in another column is asked for that column's finish_work", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        const w = yield* make({
          nodes: [
            { id: "ci", kind: "column", status: "in_review", prompt: "Check the CI.", done_when: "finish" },
            { id: "out", kind: "column", status: "backlog" },
          ],
          edges: [{ from: "ci", port: "done", to: "out" }],
        })
        yield* move("in_review")
        const note =
          "call `finish_work`, then end your turn with a summary of what you did. A turn that ends without it leaves the task in Needs attention. The board then moves the task to Backlog."
        assert.include((yield* sent()).at(-1) ?? "", note)
        // The prompt's launch fails here: the workflow still waits.
        assert.strictEqual((yield* latest(w)).state, "running")
        // It says its work is done with an item unfinished: held, and asked to finish the list, then to say so.
        yield* agentFinishes({ finished: true, todos: [{ text: "Fix CI", status: "pending" }] })
        const asked = (yield* sent()).at(-1) ?? ""
        assert.isTrue(asked.startsWith("Your todo list still has unfinished items"), asked)
        assert.include(asked, note)
        assert.strictEqual((yield* latest(w)).state, "running")
        // The next run finishes the list and says so: the workflow takes it on.
        yield* agentFinishes({ finished: true, todos: [] })
        assert.strictEqual((yield* task()).status, "backlog")
        assert.strictEqual((yield* latest(w)).state, "done")
      }),
    ),
  )
})
