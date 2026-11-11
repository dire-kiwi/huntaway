import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { WorkflowNodeRun } from "@huntaway/contracts"
import { MAX_CHAIN } from "./engine/start.ts"
import { plan, runNode, withNode } from "./graph.ts"
import type { RunState } from "./graph.ts"
import {
  AT,
  ends,
  engine,
  graphOf,
  latest,
  make,
  moveTo,
  notices,
  onBoard,
  runByHand,
  runsOf,
  setTask,
  settle,
  stepAgent,
  stepThread,
  task,
  TASK,
  workable,
} from "./tests/board.ts"

// How a run goes on (huntaway's integrations/workflows/advance.test.ts): which nodes run, a run stopped or picked up after
// a restart, and runs that go on from one another.

/** Review, then fix rounds or a summary: what reviewers and summaries do, as a workflow. */
const reviewGraph = {
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

describe("advancing a run", () => {
  it.effect("a node runs when its inputs are taken, and is skipped otherwise", () =>
    Effect.gen(function* () {
      const graph = yield* graphOf({
        nodes: [
          { id: "t", kind: "trigger", on: "manual" },
          { id: "a", kind: "agent", name: "A", output: "verdict" },
          { id: "b", kind: "agent", name: "B", output: "verdict" },
          { id: "any", kind: "send_to_task" },
          { id: "all", kind: "agent", name: "Summary", join: "all" },
          { id: "after", kind: "set_status", status: "todo" },
        ],
        edges: [
          { from: "t", port: "out", to: "a" },
          { from: "t", port: "out", to: "b" },
          { from: "a", port: "issues", to: "any" },
          { from: "b", port: "issues", to: "any" },
          { from: "a", port: "pass", to: "all" },
          { from: "b", port: "pass", to: "all" },
          { from: "all", port: "done", to: "after" },
        ],
      })
      let run: Pick<RunState, "nodes" | "graph"> = { graph, nodes: { t: { state: "done", port: "out" } } }
      const step = () => {
        const planned = plan(run, AT)
        run = planned.run
        return planned.ready
      }
      assert.deepStrictEqual(step().toSorted(), ["a", "b"])
      assert.deepStrictEqual(step(), [], "nothing more until they finish")
      const end = (id: string, port: string) => {
        run = withNode(run, id, (r): WorkflowNodeRun => ({ ...r, state: "done", port }))
      }
      end("a", "pass")
      assert.deepStrictEqual(step(), [], "both wait for b")
      end("b", "issues")
      // One reviewer found issues: they're sent, and the summary (after both pass) and what follows it are skipped.
      assert.deepStrictEqual(step(), ["any"])
      assert.deepStrictEqual([runNode(run, "all").state, runNode(run, "after").state], ["skipped", "skipped"])
    }),
  )

  it.effect("the agent working again stops the run and its steps", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make(reviewGraph)
        // A review going on, its reviewer's agent working.
        const thread = yield* stepThread("rv")
        const agent = yield* stepAgent(thread)
        const run = yield* runByHand(w, {
          start: { state: "done", port: "done", start: true },
          changed: { state: "done", port: "yes" },
          review: { state: "running", thread_id: thread, after_run: "" },
        })
        const e = yield* engine
        yield* e.supersede(TASK)
        yield* settle
        let stopped = yield* latest(w)
        assert.deepStrictEqual(
          [stopped.id, stopped.state, stopped.nodes["review"]?.state, stopped.nodes["fix"]?.state, stopped.nodes["summary"]?.state],
          [run.id, "stopped", "stopped", "skipped", "skipped"],
        )
        // Its late verdict and end don't count.
        const refused = yield* Effect.flip(e.submit(yield* task(thread), agent.run.id, { verdict: "pass", serious_issues: [] }))
        assert.strictEqual(refused._tag, "WorkflowRefused")
        yield* ends(agent)
        stopped = yield* latest(w)
        assert.deepStrictEqual([stopped.state, stopped.nodes["review"]?.state], ["stopped", "stopped"])
        // A stopped run doesn't count as one that finished: the next one reviews (whose reviewer can't start here).
        yield* setTask(TASK, { status: "todo" })
        yield* moveTo("in_review")
        const again = yield* latest(w)
        assert.notStrictEqual(again.id, run.id)
        assert.deepStrictEqual([again.nodes["changed"]?.port, again.nodes["review"]?.state], ["yes", "failed"])
        // The user's Stop stops a run going on, and then there's none.
        yield* runByHand(w, { start: { state: "done", port: "done", start: true }, changed: { state: "done", port: "yes" }, review: { state: "running" } })
        assert.deepStrictEqual(yield* e.stopTask(TASK), { stopped: true })
        assert.deepStrictEqual(yield* e.stopTask(TASK), { stopped: false })
        assert.strictEqual((yield* latest(w)).state, "stopped")
      }),
    ),
  )

  it.effect("a restart fails the steps the board was running, and goes on", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "manual" },
            { id: "m", kind: "set_status", status: "todo" },
            { id: "after", kind: "set_status", status: "backlog" },
            { id: "if_failed", kind: "set_status", status: "needs_attention" },
          ],
          edges: [
            { from: "t", port: "out", to: "m" },
            { from: "m", port: "out", to: "after" },
          ],
        })
        // A run whose move step was running when the server stopped.
        yield* runByHand(w, { t: { state: "done", port: "out", start: true }, m: { state: "running" } })
        yield* (yield* engine).resume
        yield* settle
        const done = yield* latest(w)
        assert.strictEqual(done.state, "done")
        assert.deepStrictEqual([done.nodes["m"]?.state, done.nodes["m"]?.port], ["failed", "failed"])
        assert.match(done.nodes["m"]?.text ?? "", /Interrupted/)
        assert.deepStrictEqual([done.nodes["after"]?.state, done.nodes["if_failed"]?.state], ["skipped", "skipped"])
        assert.strictEqual((yield* task()).status, "in_review", "the interrupted move isn't made")
      }),
    ),
  )

  it.effect("a run carries its rounds, and the wire leaves out its task_run", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "manual" },
            { id: "m", kind: "set_status", status: "todo" },
          ],
          edges: [{ from: "t", port: "out", to: "m" }],
        })
        const run = yield* (yield* engine).run(w.id, TASK)
        assert.strictEqual(run.workflow_name, "Review")
        assert.deepStrictEqual(run.rounds, {})
        assert.isFalse("task_run" in run, "task_run is the engine's")
        yield* settle
      }),
    ),
  )

  it.effect("a restart fails agent steps whose agent never started, and leaves those running", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "manual" },
            { id: "a", kind: "agent", name: "A", output: "text" },
            { id: "b", kind: "agent", name: "B", output: "text" },
            { id: "c", kind: "agent", name: "C", output: "text" },
          ],
          edges: [
            { from: "t", port: "out", to: "a" },
            { from: "t", port: "out", to: "b" },
            { from: "t", port: "out", to: "c" },
          ],
        })
        const working = yield* stepThread("working", "C (Review) of X-1")
        const idle = yield* stepThread("idle", "B (Review) of X-1")
        const agent = yield* stepAgent(working)
        // `a` was marked running, but the server stopped before it had a thread; `b`'s thread never got its run; `c`'s
        // agent is working, and carries on.
        yield* runByHand(w, {
          t: { state: "done", port: "out", start: true },
          a: { state: "running" },
          b: { state: "running", thread_id: idle, after_run: "" },
          c: { state: "running", thread_id: working, after_run: "" },
        })
        const e = yield* engine
        yield* e.resume
        yield* settle
        let r = yield* latest(w)
        assert.strictEqual(r.state, "running", "c's agent is still working")
        assert.deepStrictEqual([r.nodes["a"]?.state, r.nodes["b"]?.state, r.nodes["c"]?.state], ["failed", "failed", "running"])
        assert.match(r.nodes["a"]?.text ?? "", /Interrupted/)
        // Once c's agent is gone too (a second restart), the run ends.
        yield* (yield* SqlClient.SqlClient)`UPDATE runs SET status = 'exited' WHERE id = ${agent.run.id}`.pipe(Effect.orDie)
        yield* e.resume
        yield* settle
        r = yield* latest(w)
        assert.deepStrictEqual([r.state, r.nodes["c"]?.state], ["done", "failed"])
      }),
    ),
  )

  it.effect("a workflow that moves a task from column to column and back stops after a few runs in a row", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "backlog" })
        const w = yield* make({
          nodes: [
            { id: "review", kind: "column", status: "in_review" },
            { id: "todo", kind: "column", status: "todo" },
          ],
          edges: [
            { from: "review", port: "done", to: "todo" },
            { from: "todo", port: "done", to: "review" },
          ],
        })
        const warned = Effect.map(notices(), (all) => all.filter((n) => /moved the task \d+ times in a row/.test(n)).length)
        yield* moveTo("in_review")
        assert.strictEqual(yield* warned, 1, "it says why it stopped")
        assert.strictEqual((yield* runsOf(w)).length, MAX_CHAIN, "runs in a row, counting the first")
        assert.strictEqual((yield* latest(w)).state, "done")
        // Moving the task by hand starts a chain of its own.
        yield* moveTo((yield* task()).status === "todo" ? "in_review" : "todo")
        assert.strictEqual((yield* runsOf(w)).length, 2 * MAX_CHAIN)
        assert.strictEqual(yield* warned, 2)
      }),
    ),
  )
})
