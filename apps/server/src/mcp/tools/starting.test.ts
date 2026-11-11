import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { TaskId } from "@huntaway/contracts"
import { TestBoard, TestMcp, TestMcpOver, TestTools } from "@huntaway/testing"
import { Runs } from "../../runs/Runs.ts"
import { RunRepo } from "../../runs/RunRepo.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { Threads } from "../../threads/Threads.ts"
import { NOT_STARTED } from "./tasks.ts"
import { agentOf, agentOn, assistant, call, err, idOf, ok, profile, project, setTask, task } from "./tests/board.ts"

// The task tools that start agents (the old local.test.ts's `create_task_starts_its_task_unless_told_not_to`,
// `update_task_moving_a_todo_task_to_in_progress_starts_it`, and the `send_to_task` cases of resolve.test.ts and
// local.test.ts), through `Runs`. This test board has no ia-shim: a run is registered (its message written, the task
// running) and its launch gives up, which is what "started" means here. A call from another host's agent, from before
// `create_task` started tasks by default, is M7's (linked hosts).

/** Whether the task's agent was started: a run was registered for it, with the start message or the one sent. */
const started = (id: TaskId) =>
  Effect.gen(function* () {
    const latest = yield* (yield* RunRepo).latest(id)
    if (Option.isSome(latest)) yield* (yield* Runs).launched(id)
    return Option.isSome(latest)
  })

const userMessages = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(Threads, (threads) => threads.stored(id)),
    (s) => s.entries.filter((e) => e.item.type === "user_message"),
  )

const noAgents = TestMcpOver().pipe(Layer.provideMerge(TestTools.layer), Layer.provideMerge(TestBoard({ noAgents: true })))

describe("starting agents", () => {
  it.effect("create_task starts its task unless told not to", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Me"))
      const tasks = yield* Tasks
      const create = (args: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const v = ok(yield* call(me, "create_task", args))
          assert.isUndefined(v["note"])
          return yield* tasks.get(idOf(v))
        })
      // Left out, it starts: the task moves to in_progress and its agent is sent the start prompt.
      let t = yield* create({ title: "Go" })
      assert.isTrue(yield* started(t.id))
      assert.strictEqual((yield* tasks.get(t.id)).status, "in_progress")
      const [first] = yield* userMessages(t.id)
      assert.isTrue(first?.meta.start === true && first.meta.auto === true)
      // So it does put in todo, where tasks go anyway.
      assert.isTrue(yield* started((yield* create({ title: "Todo", status: "todo" })).id))
      // Asked not to, it waits in todo.
      t = yield* create({ title: "Later", start: false })
      assert.deepStrictEqual([t.status, yield* started(t.id), (yield* userMessages(t.id)).length], ["todo", false, 0])
      // Put in the backlog (or done), it isn't started, unless asked to be.
      t = yield* create({ title: "Someday", status: "backlog" })
      assert.deepStrictEqual([t.status, yield* started(t.id)], ["backlog", false])
      t = yield* create({ title: "Finished", status: "done" })
      assert.deepStrictEqual([t.status, yield* started(t.id)], ["done", false])
      assert.isTrue(yield* started((yield* create({ title: "Now", status: "backlog", start: true })).id))
      // With dependencies that aren't merged, it's queued in in_progress.
      t = yield* create({ title: "After", depends_on: ["KIW-4"] })
      assert.deepStrictEqual([t.status, t.waiting, yield* started(t.id)], ["in_progress", true, false])
      // A scratch task starts too.
      assert.isTrue(yield* started((yield* create({ title: "Look into it", type: "scratch" })).id))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("on a host that can't run agents, create_task makes the task and says it wasn't started", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Me"))
      const v = ok(yield* call(me, "create_task", { title: "Nowhere to run" }))
      assert.strictEqual(v["note"], NOT_STARTED)
      const t = yield* (yield* Tasks).get(idOf(v))
      assert.deepStrictEqual([t.status, yield* started(t.id)], ["todo", false])
      assert.strictEqual((yield* (yield* Tasks).list({ _tag: "ByProject", project_id: kiw.id })).filter((x) => x.title === "Nowhere to run").length, 1)
      // Moved to in_progress, it's left there.
      const u = ok(yield* call(me, "update_task", { task_id: t.id, status: "in_progress" }))
      assert.strictEqual(u["status"], "in_progress")
    }).pipe(Effect.provide(noAgents)),
  )

  it.effect("update_task moving a todo or backlog task that hasn't run to in_progress starts it", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Me"))
      const todo = yield* task(kiw, "Waiting")
      const backlog = yield* task(kiw, "Someday")
      yield* setTask(backlog.id, { status: "backlog" })
      const reviewed = yield* task(kiw, "Reviewed")
      yield* setTask(reviewed.id, { status: "in_review" })
      const update = (id: TaskId, args: Readonly<Record<string, unknown>>) => Effect.map(call(me, "update_task", { task_id: id, ...args }), ok)
      yield* update(todo.id, { status: "in_progress" })
      assert.isTrue(yield* started(todo.id))
      yield* update(backlog.id, { status: "in_progress" })
      assert.isTrue(yield* started(backlog.id))
      // Not one coming back from review, nor any other change.
      yield* update(reviewed.id, { status: "in_progress" })
      assert.deepStrictEqual([(yield* (yield* Tasks).get(reviewed.id)).status, yield* started(reviewed.id)], ["in_progress", false])
      // Nor one that has run before, parked back in todo: its session would be resumed with an empty prompt.
      const parked = yield* task(kiw, "Parked")
      yield* setTask(parked.id, { session_id: "an-earlier-session" })
      yield* update(parked.id, { status: "in_progress" })
      assert.deepStrictEqual([(yield* (yield* Tasks).get(parked.id)).status, yield* started(parked.id)], ["in_progress", false])
      const other = yield* task(kiw, "Other")
      yield* update(other.id, { title: "Renamed" })
      assert.deepStrictEqual([(yield* (yield* Tasks).get(other.id)).status, yield* started(other.id)], ["todo", false])
      // Nor the caller's own task.
      yield* setTask(me.run.task_id, { status: "todo" })
      yield* update(me.run.task_id, { status: "in_progress" })
      const sql = yield* SqlClient.SqlClient
      const runs = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM runs WHERE task_id = ${me.run.task_id}`.pipe(Effect.orDie)
      assert.strictEqual(runs[0]?.n, 1)
    }).pipe(Effect.provide(TestMcp())),
  )
})

describe("send_to_task", () => {
  it.effect("sends another task's agent a message as another agent's, starting it", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Me"))
      const other = yield* task(kiw, "Other")
      const v = ok(yield* call(me, "send_to_task", { task_id: "KIW-2", message: "Have a look at this" }))
      assert.deepStrictEqual([v["key"], v["running"]], ["KIW-2", true])
      assert.isTrue(yield* started(other.id))
      const said = (yield* userMessages(other.id)).find((e) => e.item.type === "user_message" && e.item.text.includes("Have a look at this"))
      assert.isTrue(said?.meta.from_agent === true)
      // Not to itself.
      assert.strictEqual(err(yield* call(me, "send_to_task", { task_id: "KIW-1", message: "hi" })), "cannot send a message to your own task")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a review thread, and another profile's assistant, aren't tasks to send to", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal", ["work"])
      const work = yield* profile("work", ["personal"])
      const kiw = yield* project(p, "kiwicd", "KIW")
      const reviewed = yield* task(kiw, "Reviewed")
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO tasks (id, profile_id, project_id, kind, parent_id, title, status, last_activity_at, created_at, updated_at)
        VALUES ('review-thread', ${p.id}, ${kiw.id}, 'review', ${reviewed.id}, 'review', 'todo', '', '', '')`.pipe(Effect.orDie)
      const theirs = yield* assistant(work)
      const me = yield* agentOf(p)
      assert.strictEqual(err(yield* call(me, "send_to_task", { task_id: "review-thread", message: "Approve it" })), "not found: task review-thread")
      for (const r of ["work:A-1", theirs]) err(yield* call(me, "send_to_task", { task_id: r, message: "hi" }))
      assert.isFalse(yield* started(theirs))
    }).pipe(Effect.provide(TestMcp())),
  )
})
