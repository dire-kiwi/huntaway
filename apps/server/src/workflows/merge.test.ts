import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { fakeAgent } from "@huntaway/testing"
import { Merges } from "../merge/Merges.ts"
import { Actor } from "../platform/Changes.ts"
import { toJson } from "../platform/columns.ts"
import { isMerged } from "../tasks/checks.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Workflows } from "./Workflows.ts"
import { AT, ends, engine, graphOf, latest, make, onBoard, PROJECT, runsOf, sent, setTask, settle, task, TASK, workable } from "./tests/board.ts"

// Merges in a workflow (huntaway's integrations/workflows/merge.test.ts): Ready for merge's column, the move to Done once
// the agent says it's merged, and the merge slot.

/** The task's merge run ends, having said it's merged with finish_work (`said`) or not. */
const mergeEnds = (said: boolean, id: TaskId = TASK) =>
  Effect.gen(function* () {
    yield* setTask(id, { status: "ready_for_merge", merging: true, running: true })
    const agent = yield* fakeAgent({ task: id, kind: "prompt" })
    if (said) yield* (yield* SqlClient.SqlClient)`UPDATE runs SET finished = 1 WHERE id = ${agent.run.id}`.pipe(Effect.orDie)
    yield* ends(agent)
  })

/** Ready for merge, then Done: what moves a merged task there. */
const toDone = {
  nodes: [
    { id: "merge", kind: "column", status: "ready_for_merge" },
    { id: "done", kind: "column", status: "done" },
  ],
  edges: [{ from: "merge", port: "done", to: "done" }],
}

/** In review, Ready for merge, a check and Done, with `edges`. */
const fourColumns = (edges: ReadonlyArray<object>) => ({
  nodes: [
    { id: "review", kind: "column", status: "in_review" },
    { id: "merge", kind: "column", status: "ready_for_merge" },
    { id: "c", kind: "condition", check: "has_pr" },
    { id: "done", kind: "column", status: "done" },
  ],
  edges,
})

describe("merges in a workflow", () => {
  it.effect("a merge goes on from Ready for merge", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make({
          nodes: [
            { id: "merge", kind: "column", status: "ready_for_merge" },
            { id: "c", kind: "condition", check: "has_pr" },
          ],
          edges: [{ from: "merge", port: "done", to: "c" }],
        })
        const tasks = yield* Tasks
        // Moved to Done without being merged: nothing.
        yield* tasks.update(TASK, { status: "done", resolution: "wont_fix" }, Actor.user)
        yield* settle
        assert.deepStrictEqual(yield* runsOf(w), [])
        yield* tasks.update(TASK, { status: "in_review" }, Actor.user)
        yield* tasks.update(TASK, { status: "done", resolution: "done" }, Actor.user)
        yield* settle
        const run = yield* latest(w)
        assert.deepStrictEqual([run.source, run.state, run.nodes["c"]?.port], ["merged", "done", "no"])
      }),
    ),
  )

  // A workflow whose Ready for merge goes on to Done moves the task there once its agent says it's merged.
  it.effect("a merge the agent says is done is moved to Done by the workflow", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        // Only Ready for merge's done, and what comes after it, go into Done: not from another column, nor from a step
        // that another column's run reaches too (a review that finds no pull request would move the task to Done unmerged).
        for (const edges of [
          [{ from: "review", port: "done", to: "done" }],
          [
            { from: "review", port: "done", to: "c" },
            { from: "c", port: "yes", to: "done" },
          ],
          [
            { from: "review", port: "done", to: "c" },
            { from: "merge", port: "done", to: "c" },
            { from: "c", port: "no", to: "done" },
          ],
        ]) {
          const refused = yield* Effect.flip(
            (yield* Workflows).create({ project_id: PROJECT, name: "Review", graph: yield* graphOf(fourColumns(edges)), enabled: true }),
          )
          assert.include(refused._tag === "Invalid" ? refused.reason : refused._tag, "only Ready for merge's done")
        }
        // Without a line into Done, the agent sets it done itself, as before.
        const w = yield* make(fourColumns([{ from: "merge", port: "done", to: "c" }]))
        const facts = (yield* engine).facts
        assert.isNull(yield* facts.mergeFinish(yield* task()))
        const workflows = yield* Workflows
        yield* workflows.update(w.id, {
          graph: yield* graphOf(
            fourColumns([
              { from: "merge", port: "done", to: "c" },
              { from: "c", port: "no", to: "done" },
            ]),
          ),
        })
        const finish = (yield* facts.mergeFinish(yield* task())) ?? ""
        assert.isTrue(
          finish.startsWith("Once it is merged, call `finish_work`, then end your turn with a summary of what you did: the board then moves the task to Done."),
          finish,
        )
        // It says so: out of the merge queue, and the workflow moves it to Done.
        yield* mergeEnds(true)
        let t = yield* task()
        assert.deepStrictEqual([t.status, t.merging, isMerged(t)], ["done", false, true])
        assert.deepStrictEqual(
          (yield* runsOf(w)).filter((r) => r.source === "merged").map((r) => r.state),
          ["done"],
          "once for the merge",
        )
        // It doesn't: Needs attention, saying how it should have.
        yield* mergeEnds(false)
        t = yield* task()
        assert.deepStrictEqual([t.status, t.attention_reason], ["needs_attention", "The agent finished without saying the task is merged (with finish_work)"])
        // Run by hand on a task waiting to merge, the step into Done fails: only the run after a merge moves a task there.
        yield* setTask(TASK, { status: "ready_for_merge", merging: true, attention_reason: null })
        const byHand = yield* (yield* engine).run(w.id, TASK)
        yield* settle
        const ran = yield* latest(w)
        assert.strictEqual(ran.id, byHand.id)
        assert.deepStrictEqual([ran.nodes["done"]?.state, ran.nodes["done"]?.text], ["failed", "only the run after a merge can move the task to Done"])
        t = yield* task()
        assert.deepStrictEqual([t.status, t.merging], ["ready_for_merge", true])
        // With the workflow off, finish_work alone isn't a merge: the board's own merge wants the task set done.
        yield* workflows.update(w.id, { enabled: false })
        yield* mergeEnds(true)
        t = yield* task()
        assert.strictEqual(t.attention_reason, "The agent finished without marking the task merged", "without the workflow it's the board's merge")
      }),
    ),
  )

  // The merge slot came free as the agent said its task was merged, before the workflow moved it to Done, so a task
  // stacked on it, next in the queue, was told to merge onto the merged task's branch.
  it.effect("a merge its workflow moves to Done holds the slot until it does", () =>
    onBoard(
      Effect.gen(function* () {
        const dir = yield* workable()
        yield* make(toDone)
        const b = TaskId.make("t2")
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO tasks ${sql.insert({
          id: b,
          profile_id: "p",
          project_id: PROJECT,
          number: 2,
          title: "Stacked on it",
          description: "",
          status: "ready_for_merge",
          use_worktree: 1,
          worktree_state: "ready",
          worktree_path: dir,
          branch: "ia/x-2",
          base_branch: "ia/x-1",
          start_from: yield* toJson({ type: "task", task_id: TASK }),
          merging: 1,
          position: 1e9,
          last_activity_at: AT,
          created_at: AT,
          updated_at: AT,
        })}`.pipe(Effect.orDie)
        // A, merged but not moved yet, holds the slot: B isn't asked to merge until the workflow has moved A to Done,
        // and then merges where A went, as A is merged.
        yield* mergeEnds(true)
        assert.strictEqual((yield* task()).status, "done")
        const asked = yield* sent(b)
        assert.strictEqual(asked.length, 1, asked.join("\n---\n"))
        assert.include(asked[0] ?? "", "which is merged already, so merge it into `main`")
        assert.notInclude(asked[0] ?? "", "isn't merged yet")
      }),
    ),
  )

  // Any task in Ready for merge out of the queue held the merge slot, so one made straight in that column stopped every
  // later merge in its project.
  it.effect("a task made in Ready for merge doesn't hold the merge slot", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const a = yield* (yield* Tasks).create({ project_id: PROJECT, title: "Made there", status: "ready_for_merge" }, Actor.user)
        assert.deepStrictEqual([a.status, a.merging], ["ready_for_merge", false])
        // B queued to merge behind it: it's asked to merge.
        yield* setTask(TASK, { status: "ready_for_merge", merging: true })
        yield* (yield* Merges).reconcileLane(PROJECT)
        yield* settle
        const asked = (yield* sent())[0] ?? ""
        assert.isTrue(asked.startsWith('The user moved this task to "Ready for merge"'), asked)
      }),
    ),
  )

  // The server stopping between the agent saying it's merged and the workflow's run starting left the task holding the
  // merge slot for good.
  it.effect("a merge handed to its workflow is picked up again on a restart", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const w = yield* make(toDone)
        const sql = yield* SqlClient.SqlClient
        // As the end of the merge run leaves it: its run said it's merged, and it's out of the queue.
        const handed = Effect.gen(function* () {
          const agent = yield* fakeAgent({ task: TASK, kind: "prompt" })
          yield* sql`UPDATE runs SET status = 'exited', finished = 1 WHERE id = ${agent.run.id}`.pipe(Effect.orDie)
          yield* setTask(TASK, { status: "ready_for_merge", merging: false, running: false, attention_reason: null })
        })
        yield* handed
        yield* (yield* engine).resume
        yield* settle
        let t = yield* task()
        assert.deepStrictEqual([t.status, isMerged(t)], ["done", true])
        // With its workflow gone meanwhile, nothing would move it: it needs the user, and the slot is free.
        yield* (yield* Workflows).delete(w.id)
        yield* handed
        yield* (yield* engine).resume
        yield* settle
        t = yield* task()
        assert.deepStrictEqual(
          [t.status, t.attention_reason],
          ["needs_attention", "The agent said the task is merged, but no workflow that's on moves it to Done now"],
        )
      }),
    ),
  )
})
