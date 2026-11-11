import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { SqlClient } from "effect/sql"
import type { TaskId, WorkflowNodeRun, WorkflowRun } from "@huntaway/contracts"
import { git } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { ReviewRepo } from "../review/ReviewRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { upstream } from "./graph.ts"
import type { RunState } from "./graph.ts"
import { readGraph } from "./read.ts"
import { ends, engine, latest, make, onBoard, runByHand, sent, setTask, settle, stepAgent, task, TASK, workable } from "./tests/board.ts"
import { Workflows } from "./Workflows.ts"

// Agent steps (huntaway's integrations/workflows/agent_steps.test.ts): a reviewer and a summary, what a step is given,
// and a step that keeps its conversation. A test board has no ia-shim: a step the engine starts gets its thread and its
// prompt (which is what these read), and then fails to launch. A step that does its work is a run of the workflow set up
// by hand with the step running in that thread, whose scripted agent submits its verdict and ends.
//
// Not ported: `an_agent_step_gets_only_the_output_of_the_steps_before_it`'s check that a step's disabled MCP servers
// aren't in its thread's runs (`agent_tools.for_run`): what a launch gets from the project's tools is `AgentTools`
// (6.4), not on this branch; what is kept is that the step records them for its thread (`thread_tools`).

/** Review, then fix rounds or a summary: what reviewers and summaries do, as a workflow (the old `review_graph`). */
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

/** A manual start and a text step that keeps its conversation, or doesn't. */
const keeping = (keep: boolean) => ({
  nodes: [
    { id: "t", kind: "trigger", on: "manual" },
    { id: "review", kind: "agent", name: "Reviewer", output: "text", keep_conversation: keep },
  ],
  edges: [{ from: "t", port: "out", to: "review" }],
})

/** A graph as an agent gives it, read as the board keeps it. */
const graphOf = (g: unknown) => {
  const read = readGraph(g)
  return Result.isSuccess(read) ? read.success : assert.fail(read.failure)
}

/** The thread node `id` of the run works in. */
const threadOf = (run: Pick<WorkflowRun | RunState, "nodes">, id: string): TaskId => {
  const t = run.nodes[id]?.thread_id
  return t ?? assert.fail(`${id} has no thread`)
}

/** The last message thread `id` was sent. */
const lastSent = (id: TaskId) => Effect.map(sent(id), (all) => all.at(-1) ?? "")

/** A step running in `thread`, as the engine starts it. */
const running = (thread: TaskId): WorkflowNodeRun => ({ state: "running", thread_id: thread, after_run: "" })

/** Moves the task into In review (from To do) as the user does, and waits for what follows. */
const intoReview = Effect.gen(function* () {
  yield* setTask(TASK, { status: "todo", running: false })
  yield* (yield* Tasks).update(TASK, { status: "in_review" }, Actor.user)
  yield* settle
})

describe("agent steps", () => {
  it.effect("a review workflow sends its issues, then summarises once it passes", () =>
    onBoard(
      Effect.gen(function* () {
        const dir = yield* workable()
        const w = yield* make(REVIEW)
        const eng = yield* engine
        const head = yield* git(dir, ["rev-parse", "HEAD"])
        /**
         * A run of the review by hand, at the task's commit and agent run as a run that started now would be: `nodes` past
         * the check, which found a change.
         */
        const byHand = (nodes: Readonly<Record<string, WorkflowNodeRun>>, over: Partial<RunState> = {}) =>
          Effect.gen(function* () {
            const taskRun = yield* (yield* ReviewRepo).latestRun(TASK)
            return yield* runByHand(
              w,
              { start: { state: "done", port: "done", start: true }, changed: { state: "done", port: "yes" }, ...nodes },
              { source: "status", head, task_run: taskRun, ...over },
            )
          })
        /** The reviewer in `thread` submits `verdict` and ends: what follows. */
        const reviews = (thread: TaskId, verdict: "pass" | "needs_fixes", summary: string | undefined, issues: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const agent = yield* stepAgent(thread)
            yield* eng.submit(yield* task(thread), agent.run.id, { verdict, summary, serious_issues: issues })
            yield* ends(agent)
          })

        // Round 1: the review starts in a thread of the task's own, with its prompt.
        let run: WorkflowRun = yield* eng.run(w.id, TASK)
        assert.deepStrictEqual([run.nodes["changed"]?.port, run.nodes["review"]?.state], ["yes", "running"])
        const reviewer = threadOf(run, "review")
        const thread = yield* task(reviewer)
        assert.deepStrictEqual([thread.kind, thread.task_type, thread.parent_id], ["review", "workflow", TASK])
        let asked = yield* lastSent(reviewer)
        assert.isTrue(asked.includes('You are "Reviewer", a step of the workflow "Review", for task X-1') && asked.includes("call `submit_review` once"), asked)
        // Its agent can't start here: the step failed.
        yield* settle
        assert.strictEqual((yield* latest(w)).nodes["review"]?.state, "failed")

        // The review (by hand) finds an issue, which goes to the task's agent.
        const first = yield* byHand({ review: running(reviewer) })
        yield* reviews(reviewer, "needs_fixes", "One bug.", ["the bug"])
        let done = yield* latest(w)
        assert.deepStrictEqual(
          [done.id, done.state, done.nodes["fix"]?.port, done.nodes["summary"]?.state, done.rounds["fix"]],
          [first.id, "done", "sent", "skipped", 1],
        )
        const fixes = yield* lastSent(TASK)
        assert.isTrue(fixes.includes('The workflow "Review" found a serious issue') && fixes.includes("1. the bug"), fixes)

        // The agent's run (which the send started) ended: round 2, as the task enters In review again, has the reviewer
        // check the issue it found, in the same thread.
        yield* intoReview
        done = yield* latest(w)
        assert.deepStrictEqual([done.source, done.nodes["changed"]?.port], ["status", "yes"], "the agent worked since, so it changed")
        assert.strictEqual(threadOf(done, "review"), reviewer, "the step keeps its thread")
        assert.include(yield* lastSent(reviewer), "Check that they're fixed:\n\n- the bug")
        // It finds the issue again (by hand, as that run's step failed to start, which gave its round back), and with no
        // rounds left the task is left for the user.
        yield* byHand({ review: running(reviewer) }, { rounds: { fix: 1 } })
        yield* reviews(reviewer, "needs_fixes", undefined, ["the bug"])
        assert.strictEqual((yield* latest(w)).nodes["fix"]?.port, "exhausted")
        let t = yield* task()
        assert.strictEqual(t.status, "needs_attention")
        assert.include(t.attention_reason ?? "", "after a round of fixes")

        // Run by hand, with fresh rounds: it passes, and the summary is written.
        yield* setTask(TASK, { status: "in_review" })
        run = yield* eng.run(w.id, TASK)
        assert.deepStrictEqual(run.rounds, {})
        yield* settle
        yield* byHand({ review: running(reviewer) }, { source: "manual" })
        yield* reviews(reviewer, "pass", "Good.", [])
        const summarizer = threadOf(yield* latest(w), "summary")
        asked = yield* lastSent(summarizer)
        assert.isTrue(
          asked.includes("Summarise X-1.") && asked.includes('The step "Reviewer" before you said:\n\n> Good.') && !asked.includes("submit_review"),
          asked,
        )
        // The summary (by hand) can't submit a verdict: it writes its output.
        yield* byHand({ review: { state: "done", port: "pass", verdict: "pass", text: "Good." }, summary: running(summarizer) })
        const writer = yield* stepAgent(summarizer)
        const refused = yield* Effect.flip(eng.submit(yield* task(summarizer), writer.run.id, { verdict: "pass", serious_issues: [] }))
        assert.include(refused.reason, "reports with its last message")
        yield* ends(writer, "It fixes the thing.")
        done = yield* latest(w)
        assert.deepStrictEqual(
          [done.state, done.nodes["summary"]?.text, done.nodes["review"]?.text, done.nodes["fix"]?.state],
          ["done", "It fixes the thing.", "Good.", "skipped"],
        )

        // Nothing changed since: entering In review again doesn't review it again.
        yield* intoReview
        done = yield* latest(w)
        assert.deepStrictEqual([done.state, done.nodes["changed"]?.port, done.nodes["review"]?.state], ["done", "no", "skipped"])
      }),
    ),
  )

  it.effect("an agent step gets only the output of the steps before it", () =>
    onBoard(
      Effect.gen(function* () {
        // Which steps those are: those with a path to it, whatever is in between.
        const g = graphOf({
          nodes: [
            { id: "t", kind: "trigger", on: "manual" },
            { id: "a", kind: "agent", name: "A" },
            { id: "side", kind: "agent", name: "Aside" },
            { id: "c", kind: "condition", check: "has_pr" },
            { id: "b", kind: "agent", name: "B" },
          ],
          edges: [
            { from: "t", port: "out", to: "a" },
            { from: "t", port: "out", to: "side" },
            { from: "a", port: "done", to: "c" },
            { from: "c", port: "no", to: "b" },
          ],
        })
        assert.deepStrictEqual(
          upstream(g, "b").map((n) => n.id),
          ["a"],
        )

        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "t", kind: "trigger", on: "manual" },
            { id: "summary", kind: "agent", name: "Summary", prompt: "Summarise it." },
            { id: "post", kind: "agent", name: "Post", prompt: "Turn it into a post.", skills: ["tldr"], input_only: true, disabled_mcp_servers: ["docs"] },
          ],
          edges: [
            { from: "t", port: "out", to: "summary" },
            { from: "summary", port: "done", to: "post" },
          ],
        })
        const summary = threadOf(yield* (yield* engine).run(w.id, TASK), "summary")
        // A step that isn't input-only is told where the work is.
        assert.include(yield* lastSent(summary), "checked out in your working directory")
        yield* settle
        // The summary (by hand) says what it found; the post is given it.
        yield* runByHand(w, { t: { state: "done", port: "out", start: true }, summary: running(summary) })
        yield* ends(yield* stepAgent(summary), "It fixes the thing.")
        const post = threadOf(yield* latest(w), "post")
        const asked = yield* lastSent(post)
        assert.include(asked, 'The step "Summary" before you said:\n\n> It fixes the thing.')
        assert.isTrue(asked.includes("Turn it into a post.") && asked.includes("`/tldr`"), asked)
        assert.isTrue(
          !asked.includes("checked out in your working directory") && !asked.includes("Make it work."),
          "an input-only step isn't told about the work",
        )
        // The servers a step turns off are its thread's; the other steps' threads have them all.
        const sql = yield* SqlClient.SqlClient
        const off = (thread: TaskId) =>
          Effect.map(
            sql<{ readonly disabled_mcp_servers: string }>`SELECT disabled_mcp_servers FROM thread_tools WHERE task_id = ${thread}`.pipe(Effect.orDie),
            (rows) => rows[0]?.disabled_mcp_servers ?? "[]",
          )
        assert.deepStrictEqual([yield* off(post), yield* off(summary)], ['["docs"]', "[]"])
      }),
    ),
  )

  it.effect("an agent step can keep its conversation from one run to the next", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make(keeping(true))
        const step = w.graph.nodes[1]
        assert.isTrue(step?.kind === "agent" && step.keep_conversation === true)
        const eng = yield* engine
        // Its first run has no conversation to go on from.
        const thread = threadOf(yield* eng.run(w.id, TASK), "review")
        assert.notInclude(yield* lastSent(thread), "goes on from your conversation")
        yield* settle
        // Its agent's session, as its run's output records it: the step (by hand) ends with it.
        yield* setTask(thread, { session_id: "s1" })
        yield* runByHand(w, { t: { state: "done", port: "out", start: true }, review: running(thread) })
        yield* ends(yield* stepAgent(thread), "Looks fine.")
        assert.strictEqual((yield* latest(w)).nodes["review"]?.text, "Looks fine.")

        assert.strictEqual(threadOf(yield* eng.run(w.id, TASK), "review"), thread, "the same thread")
        assert.strictEqual((yield* task(thread)).session_id, "s1", "its conversation goes on")
        assert.include(yield* lastSent(thread), "This goes on from your conversation the last time this step ran")
        yield* settle

        // Without it, each run is a fresh conversation.
        yield* (yield* Workflows).update(w.id, { graph: graphOf(keeping(false)) })
        assert.strictEqual(threadOf(yield* eng.run(w.id, TASK), "review"), thread)
        assert.isNull((yield* task(thread)).session_id, "a fresh conversation")
        assert.notInclude(yield* lastSent(thread), "goes on from your conversation")
      }),
    ),
  )
})
