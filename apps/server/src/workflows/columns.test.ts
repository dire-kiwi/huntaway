import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { COLUMN_ROUNDS, Timestamp } from "@huntaway/contracts"
import { Workflows } from "./Workflows.ts"
import {
  agentFinishes,
  engine,
  graphOf,
  latest,
  lifecycle,
  make,
  moveTo,
  onBoard,
  project,
  runByHand,
  runsOf,
  sent,
  setProject,
  setTask,
  settle,
  task,
  TASK,
  workable,
} from "./tests/board.ts"

// Column nodes (huntaway's integrations/workflows/columns.test.ts): a column's prompt, the agent's work there, the lines
// out of and back into a column, and their rounds. A message the engine sends the task's agent registers its run (the
// message is in the thread) and then fails to launch here (no ia-shim), which leaves the task in Needs attention; the
// agent's work is a scripted run of it (`agentFinishes`).

const last = <A>(all: ReadonlyArray<A>): A | undefined => all[all.length - 1]

describe("column nodes", () => {
  it.effect("an edge into a column moves the task, and the next run starts from there", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "backlog" })
        const w = yield* make({
          nodes: [
            { id: "todo", kind: "column", status: "todo" },
            { id: "review", kind: "column", status: "in_review" },
            { id: "has_pr", kind: "condition", check: "has_pr" },
          ],
          edges: [
            { from: "todo", port: "done", to: "review" },
            { from: "review", port: "done", to: "has_pr" },
          ],
        })
        yield* moveTo("todo")
        assert.strictEqual((yield* task()).status, "in_review")
        const [second, first] = yield* runsOf(w)
        assert.strictEqual((yield* runsOf(w)).length, 2)
        // The first ends at In review, which it moved the task to; the second starts there and goes on.
        assert.deepStrictEqual(
          [first?.nodes["todo"]?.start, first?.nodes["review"]?.state, first?.nodes["review"]?.port, first?.nodes["has_pr"]?.state],
          [true, "done", undefined, "skipped"],
        )
        assert.deepStrictEqual([second?.nodes["review"]?.start, second?.nodes["has_pr"]?.port, second?.nodes["todo"]?.state], [true, "no", "skipped"])
        assert.deepStrictEqual([first?.state, second?.state], ["done", "done"])
      }),
    ),
  )

  it.effect("a column's prompt is the start prompt, and says what the board does next", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const facts = (yield* engine).facts
        const p = yield* project
        let t = yield* task()
        assert.isNull(yield* facts.startInstructions(t, p), "without a workflow, the project's start prompt")
        const w = yield* make(lifecycle())
        const text = (yield* facts.startInstructions(t, p)) ?? ""
        assert.isTrue(text.startsWith("Build Fix the thing."), text)
        assert.include(text, "end your turn with a summary of what you did. The board then pushes your branch and opens its pull request")
        assert.include(text, "and moves the task to In review.")
        assert.isTrue(yield* facts.boardOpensPr(t), "the agent isn't told to open it")
        assert.strictEqual(yield* facts.mergeInstructions(t), "Squash it into X-1.")
        // A blank prompt is the project's start prompt; waiting for finish_work says how.
        yield* (yield* Workflows).update(w.id, { graph: yield* graphOf(lifecycle({ work: { prompt: "", done_when: "finish" } })) })
        const blank = (yield* facts.startInstructions(t, p)) ?? ""
        assert.isTrue(blank.startsWith("Start working on this task.\n\nWhen the work you were asked for here is complete, call `finish_work`"), blank)
        // Off, it's the project's again.
        yield* (yield* Workflows).update(w.id, { enabled: false })
        t = yield* task()
        assert.deepStrictEqual([yield* facts.startInstructions(t, p), yield* facts.mergeInstructions(t), yield* facts.boardOpensPr(t)], [null, null, false])
      }),
    ),
  )

  it.effect("a finish_work column needs attention when the agent doesn't say its work is done", () =>
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
        yield* agentFinishes()
        let t = yield* task()
        assert.deepStrictEqual(
          [t.status, t.attention_reason],
          ["needs_attention", "The agent ended its turn without saying its work in In progress is done (with finish_work)"],
        )
        assert.deepStrictEqual(yield* runsOf(w), [])
        // It says so with the tool (the run's flag, which `finish_work` sets: mcp/tools' tests).
        yield* agentFinishes({ finished: true })
        t = yield* task()
        assert.strictEqual(t.status, "backlog")
      }),
    ),
  )

  it.effect("a column with a prompt sends it, and waits for the agent's work there", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        const w = yield* make({
          nodes: [
            { id: "ci", kind: "column", status: "in_review", prompt: "Check the CI of {{branch}}." },
            { id: "out", kind: "column", status: "backlog" },
          ],
          edges: [{ from: "ci", port: "done", to: "out" }],
        })
        yield* moveTo("in_review")
        const waiting = yield* latest(w)
        // Its agent was sent the prompt; that run's launch fails here, which needs attention: still waiting.
        assert.deepStrictEqual([waiting.state, waiting.nodes["ci"]?.state], ["running", "running"])
        assert.strictEqual(
          last(yield* sent()),
          "Check the CI of ia/x-1.\n\nWhen you're done, end your turn with a summary of what you did. The board then moves the task to Backlog.",
        )
        assert.strictEqual((yield* task()).status, "needs_attention")
        // The user answers, and the agent's work is done: the run goes on from the column.
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "backlog")
        const run = yield* latest(w)
        assert.strictEqual(run.id, waiting.id)
        assert.deepStrictEqual([run.state, run.source, run.nodes["ci"]?.port, run.nodes["out"]?.state], ["done", "finished", "done", "done"])
        // Moved out of the column it waits at, it stops waiting.
        yield* setTask(TASK, { status: "todo" })
        yield* moveTo("in_review")
        const again = yield* latest(w)
        assert.strictEqual(again.state, "running")
        yield* moveTo("todo")
        const stopped = yield* latest(w)
        assert.deepStrictEqual([stopped.id, stopped.state, stopped.detail], [again.id, "stopped", "Stopped because the task left In review."])
      }),
    ),
  )

  it.effect("a column whose work ends with nothing after it goes to review without starting again", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        const w = yield* make({ nodes: [{ id: "ci", kind: "column", status: "in_review", prompt: "Check the CI." }], edges: [] })
        yield* moveTo("in_review")
        assert.strictEqual((yield* latest(w)).state, "running")
        yield* agentFinishes()
        assert.strictEqual((yield* task()).status, "in_review")
        // Back in In review, whose work just ended: not sent the prompt again.
        const runs = yield* runsOf(w)
        assert.deepStrictEqual(
          runs.map((r) => r.state),
          ["done"],
        )
        assert.strictEqual((yield* sent()).filter((m) => m.startsWith("Check the CI.")).length, 1)
      }),
    ),
  )

  it.effect("an edge into In progress gives the agent the issues found or the column's prompt", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ task: { session_id: "sess" } })
        const w = yield* make({
          nodes: [
            { id: "review", kind: "column", status: "in_review" },
            { id: "has_pr", kind: "condition", check: "has_pr" },
            { id: "work", kind: "column", status: "in_progress", prompt: "Open a PR for {{task.key}} after all." },
          ],
          edges: [
            { from: "review", port: "done", to: "has_pr" },
            { from: "has_pr", port: "no", to: "work" },
          ],
        })
        const run = yield* (yield* engine).run(w.id, TASK)
        assert.deepStrictEqual([run.state, run.nodes["work"]?.state, run.rounds], ["done", "done", { work: 1 }])
        const message = last(yield* sent()) ?? ""
        assert.isTrue(message.startsWith("Open a PR for X-1 after all."), message)
        // The task went to In progress for it; the agent's run then fails to launch here.
        yield* settle
        const t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.isTrue((t.attention_reason ?? "").startsWith("Run failed"), t.attention_reason ?? "")
      }),
    ),
  )

  it.effect("a column with nothing after it runs nothing, and tabs keep each step's last output", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "review", kind: "column", status: "in_review" },
            { id: "reviewer", kind: "agent", name: "Reviewer", output: "verdict", tab: "Review" },
            { id: "attention", kind: "column", status: "needs_attention" },
          ],
          edges: [
            { from: "review", port: "done", to: "reviewer" },
            { from: "reviewer", port: "failed", to: "attention" },
          ],
        })
        yield* moveTo("needs_attention")
        assert.deepStrictEqual(yield* runsOf(w), [])
        // A run whose review ran, then a later one that skipped it.
        const reviewed = yield* runByHand(
          w,
          { review: { state: "done", port: "done", start: true }, reviewer: { state: "done", port: "pass", text: "Looks good." } },
          { state: "done", created_at: Timestamp.make("2026-11-07T00:00:01.000Z") },
        )
        const skipped = yield* runByHand(
          w,
          { review: { state: "done", port: "done", start: true }, reviewer: { state: "skipped" } },
          { state: "done", created_at: Timestamp.make("2026-11-07T00:00:02.000Z") },
        )
        const e = yield* engine
        assert.deepStrictEqual(
          (yield* e.latestRuns(TASK)).map((r) => r.id),
          [skipped.id],
        )
        assert.deepStrictEqual(
          (yield* e.runsOfTask(TASK)).runs.map((r) => r.id),
          [skipped.id, reviewed.id],
        )
      }),
    ),
  )

  // In progress's run, which moves the task to In review, skipped the send after the review and gave its round back, so
  // the review and its fixes went round without end; and a check after In review compared with that run, where it hadn't
  // run, so it saw no change. The preset's shape, with a check in place of the reviewer: In progress → In review →
  // changed → no pull request → send, one round.
  it.effect("rounds of review and fixes through In progress end once they're used up", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress" },
            { id: "review", kind: "column", status: "in_review" },
            { id: "changed", kind: "condition", check: "changed" },
            { id: "has_pr", kind: "condition", check: "has_pr" },
            { id: "fix", kind: "send_to_task", message: "Open its pull request.", max_rounds: 1 },
          ],
          edges: [
            { from: "work", port: "done", to: "review" },
            { from: "review", port: "done", to: "changed" },
            { from: "changed", port: "yes", to: "has_pr" },
            { from: "has_pr", port: "no", to: "fix" },
          ],
        })
        // Round 1, from In review: sent to the agent.
        yield* moveTo("in_review")
        const r1 = yield* latest(w)
        assert.deepStrictEqual([r1.nodes["fix"]?.port, r1.rounds], ["sent", { fix: 1 }])
        // The agent works on it, and its work in In progress is done.
        yield* agentFinishes()
        const [r3, r2] = yield* runsOf(w)
        assert.deepStrictEqual(
          [r2?.source, r2?.state, r2?.nodes["fix"]?.state, r2?.rounds],
          ["finished", "done", "skipped", { fix: 1 }],
          "the round is kept past In review",
        )
        // In review again, which In progress's run moved it to: the check sees the agent's work since round 1 (not
        // since In progress's run), and with no round left the task needs attention.
        assert.deepStrictEqual([r3?.source, r3?.nodes["changed"]?.port, r3?.nodes["fix"]?.port], ["status", "yes", "exhausted"])
        assert.strictEqual((yield* runsOf(w)).length, 3)
        const t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.include(t.attention_reason ?? "", "is out of rounds")
      }),
    ),
  )

  // done_when: finish held tasks to finish_work that they weren't told about: a scratch task (which doesn't get In
  // progress's prompt), and the workflow's own fix messages; and a merge run was told not to push.
  it.effect("finish_work is asked of the runs that are told about it, and a merge pushes its own work", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "in_progress", task: { task_type: "scratch" } })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress", done_when: "finish" },
            { id: "pr", kind: "open_pr" },
            { id: "start", kind: "trigger", on: "manual" },
            { id: "fix", kind: "send_to_task", message: "Fix the thing again.", max_rounds: 2 },
          ],
          edges: [
            { from: "work", port: "done", to: "pr" },
            { from: "start", port: "out", to: "fix" },
          ],
        })
        // A scratch task isn't told to call finish_work, so it isn't held to it: the workflow takes it on (whose pull
        // request fails here, with no GitHub remote).
        yield* agentFinishes()
        const t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.isTrue((t.attention_reason ?? "").startsWith('The workflow "Review" failed at Open a pull request'), t.attention_reason ?? "")
        // A code task's fix message ends saying how to finish, as its start prompt did.
        yield* setTask(TASK, { task_type: null, session_id: "sess", status: "in_review", attention_reason: null })
        yield* (yield* engine).run(w.id, TASK)
        const message = last(yield* sent()) ?? ""
        assert.isTrue(message.startsWith("Fix the thing again.\n\nWhen the work you were asked for here is complete, call `finish_work`"), message)
        assert.include(message, "The board then pushes your branch and opens its pull request")
        yield* settle
        // The board opens the pull request after In progress, so the agent isn't told to; but not when it merges.
        const facts = (yield* engine).facts
        assert.isTrue(yield* facts.boardOpensPr(yield* task()))
        yield* setTask(TASK, { merging: true })
        assert.isFalse(yield* facts.boardOpensPr(yield* task()))
        yield* setTask(TASK, { merging: false, remerge: true })
        assert.isFalse(yield* facts.boardOpensPr(yield* task()))
      }),
    ),
  )

  // An edge back into In progress gave the agent its work every time, and the run its finishing started counted no
  // chain, so a line round through the columns (here a check that never passes) went on for ever.
  it.effect("a line back into In progress ends in Needs attention once its rounds are used up", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress", prompt: "Work on {{task.key}}." },
            { id: "review", kind: "column", status: "in_review" },
            { id: "c", kind: "condition", check: "has_pr" },
          ],
          edges: [
            { from: "work", port: "done", to: "review" },
            { from: "review", port: "done", to: "c" },
            { from: "c", port: "no", to: "work" },
          ],
        })
        // From In review: each time, back to In progress with the column's prompt, and its work done there takes it to
        // In review again.
        yield* moveTo("in_review")
        let run = yield* latest(w)
        for (let round = 1; round <= COLUMN_ROUNDS; round++) {
          assert.deepStrictEqual([run.source, run.nodes["work"]?.state, run.rounds], ["status", "done", { work: round }], `round ${round}`)
          const message = last(yield* sent()) ?? ""
          assert.isTrue(message.startsWith("Work on X-1."), message)
          // Its launch fails here; then its work is done: In progress's run moves it to In review, whose run is the next round.
          yield* agentFinishes()
          run = yield* latest(w)
        }
        // Out of rounds: not moved, and the task needs attention.
        assert.strictEqual(run.nodes["work"]?.state, "failed")
        const t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.include(t.attention_reason ?? "", `gave the agent its work ${COLUMN_ROUNDS} times in a row`)
        assert.strictEqual((yield* runsOf(w)).length, 2 * COLUMN_ROUNDS + 1, "no more runs")

        // A run that goes another way gives the rounds back.
        yield* setTask(TASK, { pr_url: "https://github.com/o/r/pull/1" })
        yield* moveTo("in_review")
        run = yield* latest(w)
        assert.deepStrictEqual([run.nodes["c"]?.port, run.rounds], ["yes", {}])
      }),
    ),
  )

  // A line into In progress with no issues, and In progress with no prompt of its own (as in every preset), left a
  // started task in In progress with nothing to do; it's given In progress's start text, as a round.
  it.effect("a line into a blank In progress gives a started task the start prompt again", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable({ status: "todo", task: { session_id: "sess" } })
        yield* setProject({ start_prompt: "Read the CONTRIBUTING file first." })
        const w = yield* make({
          nodes: [
            { id: "work", kind: "column", status: "in_progress" },
            { id: "review", kind: "column", status: "in_review" },
            { id: "c", kind: "condition", check: "has_pr" },
          ],
          edges: [
            { from: "work", port: "done", to: "review" },
            { from: "review", port: "done", to: "c" },
            { from: "c", port: "no", to: "work" },
          ],
        })
        yield* moveTo("in_review")
        const run = yield* latest(w)
        assert.deepStrictEqual([run.state, run.nodes["work"]?.state, run.rounds], ["done", "done", { work: 1 }])
        const message = last(yield* sent()) ?? ""
        assert.isTrue(message.startsWith("Read the CONTRIBUTING file first.\n\nWhen you're done"), message)
        assert.include(message, "moves the task to In review")
      }),
    ),
  )
})
