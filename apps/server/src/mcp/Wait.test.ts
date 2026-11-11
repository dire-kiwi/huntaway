import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Ref, Result, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { WaitTask } from "@huntaway/contracts"
import { decodeLine } from "../agents/claude/lines.ts"
import { Actor } from "../platform/Changes.ts"
import { toJson } from "../platform/columns.ts"
import { Proc } from "../platform/Proc.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { isActivity, isWaitTool, subagentEnd } from "../runs/RunWaits.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { fakeGitHub } from "@huntaway/testing"
import type { FakeAgent, FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import type { AgentWait, Task } from "@huntaway/contracts"
import { GIVE_UP, PrPoll, PrWatch } from "../github/PrWatch.ts"
import { EVENTS, newsOf } from "../github/prWatch/pr.ts"
import { github, onGitHub, pull7, setOrigin } from "../github/tests/pullRequests.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { agentOn, at, call, err, ok, profile, project, task } from "./tools/tests/board.ts"
import { approvalOf, change, feed, reload, repoOf, WaitBoard, waitingOn } from "./tools/tests/wait.ts"
import type { CommandInput } from "./wait/CommandApproval.ts"
import { LAUNCH } from "./wait/command.ts"
import { endedName, note, period, tasksChanged } from "./wait/ended.ts"
import type { Ended } from "./wait/ended.ts"

// `Wait` (the old mcp/wait/tests.test.ts) on the whole board, through the `wait` tool as an agent calls it, on the test
// clock: deadlines are moved with `TestClock.adjust`, and what ends a wait is done once the task shows its agent
// waiting (its `task` event). The commands are real processes (`it.live` where time must pass for them). Dropped, with
// why:
// - in the pull request cases (on the live clock, their reads being the fake gh's processes, read every 10 ms as the old
//   tests' were every 100), the old `pr_watch.fake` that answered by account: the fake GitHub has no repository only
//   one account sees, so the read as the profile's account is checked by the account each call acted as;
// - `a_codex_agents_own_tool_calls_end_a_wait`: Codex is M5 (the wait tool's names are checked here);
// - `a_subagents_permission_prompt_isnt_a_move`: the prompt is `Permissions`' (3.3); what it does to the task (the
//   board's own move to Needs attention and back, without `moved_to`) is checked here;
// - `a_wait_left_for_another_doesnt_end_the_next_ones_watch` (HA-341): each wait has its own subscription now, so a
//   wait left by another can't take the next one's; that a later wait still sees a change is checked here;
// - a stored wait from before `reason` and `tasks` were stored: the cut-over needs no run going (no wait is stored).

/** An agent's output line, decoded. */
const lineOf = (v: unknown) =>
  Effect.map(toJson(v), (text) => {
    const decoded = decodeLine(text)
    return Result.isSuccess(decoded) ? decoded.success : assert.fail("not a line")
  })

/** How a subagent's lifecycle line says it ended. */
const endOf = (v: Record<string, unknown>) =>
  Effect.map(lineOf({ type: "system", ...v }), (l) =>
    l.type === "system" && (l.subtype === "task_notification" || l.subtype === "task_updated") ? subagentEnd(l) : assert.fail("not a task line"),
  )

/** An assistant message of the agent's (`parent`: a subagent's) calling `name`. */
const toolCall = (id: string, name: string, parent: string | null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
})

/** How long a wait asked for lasts. */
const req = (r: { readonly seconds?: number; readonly tasks?: number; readonly command?: string; readonly pullRequest?: boolean }) =>
  period({ seconds: r.seconds ?? null, tasks: Array.from({ length: r.tasks ?? 0 }), command: r.command ?? null, pullRequest: r.pullRequest ?? false })

/** Runs `body` on a board whose wait commands are all allowed. */
const allowed = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
    return yield* body.pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked))))
  })

/** The tasks a wait ended on, and the reviews. */
const endedOn = (ids: ReadonlyArray<string>, reviews?: ReadonlyArray<{ readonly id: string; readonly state: "passed" | "issues" }>): Ended => ({
  _tag: "Tasks",
  tasks: ids.map((id) => TaskId.make(id)),
  ...(reviews === undefined ? {} : { reviews: reviews.map((r) => ({ id: TaskId.make(r.id), state: r.state })) }),
})

const AT = (s: number) => `2026-11-10T00:00:${String(s).padStart(2, "0")}.000Z`

/** A project with a planner whose agent is running (in progress), and another task it can watch. */
const running = () =>
  Effect.gen(function* () {
    const p = yield* profile("p")
    const kiw = yield* project(p, "kiwicd", "T")
    const planner = yield* task(kiw, "planner")
    const other = yield* task(kiw, "other")
    yield* change(planner.id, { status: "in_progress", running: true })
    const me = yield* agentOn(planner)
    return { kiw, planner, other, me }
  })

/** A wait call's result, as the old tests' `ended`. */
const endedOf = (v: Readonly<Record<string, unknown>>) => v["ended"]

describe("Wait's rules", () => {
  it("says how a wait ended", () => {
    const watched: ReadonlyArray<WaitTask> = [{ id: TaskId.make("t2"), key: "T-2", status: "in_review" }]
    assert.strictEqual(note(endedOn([], [{ id: "t2", state: "passed" }]), watched), "T-2's review passed (see tasks).")
    // One that found issues moves its task too: both are said.
    assert.strictEqual(note(endedOn(["t2"], [{ id: "t2", state: "issues" }]), watched), "T-2 changed status; T-2's review found issues (see tasks).")
    assert.strictEqual(note(endedOn(["t3"]), watched), "t3 changed status (see tasks).")
    assert.strictEqual(note({ _tag: "Moved", status: "done" }, []), "The task was moved to done on the board.")
    assert.strictEqual(note({ _tag: "Command", code: null, output: "" }, []), "Your command was ended by a signal (see command.output).")
    assert.strictEqual(note({ _tag: "Message" }, []), "A message was sent to you; you'll read it once this call returns.")
    assert.strictEqual(note({ _tag: "Stopped" }, []), "The run was stopped.")
    assert.deepStrictEqual(
      (["Timeout", "Message", "Stopped", "Resumed"] as const).map((tag) => endedName({ _tag: tag })),
      ["timeout", "message", "stopped", "resumed"],
    )
    assert.strictEqual(endedName({ _tag: "Subagent", agent: null }), "subagent_finished")
    assert.strictEqual(endedName({ _tag: "Moved", status: "done" }), "task_moved")
  })

  it("a wait without tasks or a command is short", () => {
    assert.deepStrictEqual(req({}), Result.succeed(30))
    assert.deepStrictEqual(req({ seconds: 30 }), Result.succeed(30))
    // A second at least.
    assert.deepStrictEqual(req({ seconds: 0.1 }), Result.succeed(1))
    assert.deepStrictEqual(req({ tasks: 1 }), Result.succeed(600))
    assert.deepStrictEqual(req({ seconds: 7200, tasks: 1 }), Result.succeed(3600))
    assert.deepStrictEqual(req({ command: "gh pr checks 1 --watch" }), Result.succeed(600))
    assert.deepStrictEqual(req({ command: "gh pr checks 1 --watch", seconds: 300 }), Result.succeed(300))
    // HA-301: a command is the agent's own check, which may never succeed, so it hears how it's doing every 10 minutes.
    assert.deepStrictEqual(req({ command: "gh pr checks 1 --watch", seconds: 1800 }), Result.succeed(600))
    assert.deepStrictEqual(req({ command: "sleep 3500", tasks: 1, seconds: 3500 }), Result.succeed(600))
    // A wait on a pull request is watched.
    assert.deepStrictEqual(req({ pullRequest: true, seconds: 1800 }), Result.succeed(1800))
    assert.deepStrictEqual(req({ pullRequest: true }), Result.succeed(600))
    // A blank command is none.
    const e = req({ command: "  ", seconds: 1800 })
    assert.isTrue(Result.isFailure(e))
    const text = Result.isFailure(e) ? e.failure : ""
    assert.isTrue(text.includes("30 seconds at most") && text.includes("give the pull_request") && text.includes("a command that exits"), text)
    // A wait on a pull request is watched.
    assert.deepStrictEqual(req({ seconds: 1800, pullRequest: true }), Result.succeed(1800))
    assert.deepStrictEqual(req({ pullRequest: true }), Result.succeed(600))
  })

  it("a review that finished since the wait began ends it; a wait stored without reviews ends on status alone", () => {
    const t2 = TaskId.make("t2")
    const now = (state: "running" | "passed" | "stopped", s: number) => () => ({ status: "in_review" as const, review: { state, updated_at: AT(s) } })
    const from = (reviewAt?: string | null): ReadonlyArray<WaitTask> => [
      { id: t2, key: "T-2", status: "in_review", ...(reviewAt === undefined ? {} : { review_at: reviewAt === null ? null : Timestamp.make(reviewAt) }) },
    ]
    // Finished before the wait started, or a new round started: no end.
    assert.isNull(tasksChanged(from(AT(1)), now("passed", 1)))
    assert.isNull(tasksChanged(from(AT(1)), now("running", 2)))
    assert.deepStrictEqual(tasksChanged(from(AT(1)), now("passed", 3)), { _tag: "Tasks", tasks: [], reviews: [{ id: t2, state: "passed" }] })
    assert.deepStrictEqual(tasksChanged(from(null), now("passed", 3)), { _tag: "Tasks", tasks: [], reviews: [{ id: t2, state: "passed" }] })
    assert.isNull(tasksChanged(from(), now("stopped", 4)))
    assert.deepStrictEqual(
      tasksChanged(from(), () => null),
      { _tag: "Tasks", tasks: [t2] },
    )
  })

  it.effect("its own thread's other tool calls are activity; a subagent's end is a terminal status", () =>
    Effect.gen(function* () {
      assert.isTrue(isActivity(yield* lineOf(toolCall("x", "Bash", null))))
      assert.isFalse(isActivity(yield* lineOf(toolCall("x", "mcp__huntaway__wait", null))))
      // A subagent working doesn't: its agent may be waiting for it.
      assert.isFalse(isActivity(yield* lineOf(toolCall("x", "Bash", "toolu_1"))))
      assert.isFalse(isActivity(yield* lineOf({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } })))
      assert.isTrue(isWaitTool("mcp__huntaway__wait") && !isWaitTool("mcp__huntaway__wait_for") && !isWaitTool("mcp__other__wait"))
      assert.isTrue(isWaitTool("mcp__issue_agent__wait"), "runs from before the rename")
      assert.strictEqual(yield* endOf({ subtype: "task_notification", status: "completed" }), "completed")
      assert.strictEqual(yield* endOf({ subtype: "task_notification", status: "error" }), "failed")
      assert.strictEqual(yield* endOf({ subtype: "task_updated", patch: { status: "killed" } }), "stopped")
      assert.isNull(yield* endOf({ subtype: "task_updated", patch: { status: "running" } }))
    }),
  )
})

describe("Wait", () => {
  it.effect("waits out the period, showing as waiting", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* running()
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: " waiting for CI ", seconds: 1 }, "c1"))
      const w = (yield* waiting).agent_wait
      assert.deepStrictEqual([w?.reason, w?.call_id, w?.run_id], ["waiting for CI", "c1", me.run.id])
      assert.deepStrictEqual([w?.since, w?.until], ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:01.000Z"])
      yield* TestClock.adjust("999 millis")
      assert.isUndefined(f.pollUnsafe(), "not over before its deadline")
      yield* TestClock.adjust("1 milli")
      const v = ok(yield* Fiber.join(f))
      assert.deepStrictEqual([v["ended"], v["waited_seconds"]], ["timeout", 1])
      assert.strictEqual(v["note"], "The wait period is over. Check on what you were waiting for, and wait again if it isn't ready yet.")
      // Still in progress, and working again.
      const t = yield* reload(planner.id)
      assert.deepStrictEqual([t.status, t.running, t.agent_wait], ["in_progress", true, null])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("ends when a message is sent to the agent, steered in or queued", () =>
    Effect.gen(function* () {
      const { kiw, planner, me } = yield* running()
      const runs = yield* Runs
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 30 }))
      yield* waiting
      yield* runs.send(planner.id, { text: "come back", source: "user" })
      const v = ok(yield* Fiber.join(f))
      assert.deepStrictEqual([v["ended"], v["note"]], ["message", "A message was sent to you; you'll read it once this call returns."])
      // A run that takes no input: the message is queued for when it ends.
      const other = yield* task(kiw, "Another")
      yield* change(other.id, { status: "in_progress", running: true })
      const quiet = yield* agentOn(other)
      yield* (yield* FileSystem.FileSystem).remove(`${quiet.dir}/input.jsonl`).pipe(Effect.orDie)
      const waitingToo = yield* waitingOn(other.id)
      const g = yield* Effect.forkChild(call(quiet, "wait", { reason: "r", seconds: 30 }))
      yield* waitingToo
      yield* runs.send(other.id, { text: "come back", source: "user" })
      assert.strictEqual(endedOf(ok(yield* Fiber.join(g))), "message")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("ends when the run is stopped or ends, or the task is moved", () =>
    Effect.gen(function* () {
      const { kiw, planner, me } = yield* running()
      const repo = yield* RunRepo
      const waitThen = (id: string, then: Effect.Effect<void>, agent = me) =>
        Effect.gen(function* () {
          const waiting = yield* waitingOn(id)
          const f = yield* Effect.forkChild(call(agent, "wait", { reason: "r", seconds: 30 }))
          yield* waiting
          yield* then
          return ok(yield* Fiber.join(f))
        })
      // A stop marks the run, which no event announces: the next tick sees it.
      let v = yield* waitThen(planner.id, Effect.andThen(repo.update(me.run.id, { stop: "requested" }), TestClock.adjust("5 seconds")))
      assert.deepStrictEqual([v["ended"], v["note"]], ["stopped", "The run was stopped."])
      // Moved from the board or with update_task, to "Needs attention" too.
      for (const status of ["done", "needs_attention"] as const) {
        const t = yield* task(kiw, `Moved to ${status}`)
        yield* change(t.id, { status: "in_progress", running: true })
        const agent = yield* agentOn(t)
        v = yield* waitThen(t.id, Effect.asVoid(Effect.orDie((yield* Tasks).update(t.id, { status }, Actor.user))), agent)
        assert.deepStrictEqual([v["ended"], v["note"]], ["task_moved", `The task was moved to ${status} on the board.`])
      }
      // The run ended.
      const t = yield* task(kiw, "Ended")
      const agent = yield* agentOn(t)
      v = yield* waitThen(t.id, Effect.andThen(repo.end(agent.run.id, agent.run.created_at), TestClock.adjust("5 seconds")), agent)
      assert.strictEqual(v["ended"], "stopped")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("the board's own moves of the task (a subagent's prompt) don't end it", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* running()
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 2 }))
      yield* waiting
      // The prompt moves the task to Needs attention, and answering it moves it back, without `moved_to`.
      yield* change(planner.id, { status: "needs_attention" })
      yield* TestClock.adjust("1 second")
      yield* change(planner.id, { status: "in_progress" })
      yield* TestClock.adjust("1 second")
      assert.strictEqual(endedOf(ok(yield* Fiber.join(f))), "timeout")
      const t = yield* reload(planner.id)
      assert.deepStrictEqual([t.status, t.agent_wait], ["in_progress", null])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("its own thread's other tool calls end a wait; its subagents' don't", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* running()
      yield* feed(me, toolCall("sub", "Agent", null), 10)
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 30 }))
      yield* waiting
      yield* feed(me, toolCall("t1", "Bash", "sub"), 20)
      assert.isNotNull((yield* reload(planner.id)).agent_wait)
      yield* feed(me, toolCall("t2", "Read", null), 30)
      assert.strictEqual(endedOf(ok(yield* Fiber.join(f))), "resumed")
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("only a subagent's terminal status wakes its own run's wait, the first only", () =>
    Effect.gen(function* () {
      const { planner, other, me } = yield* running()
      // An Agent call needn't be the first content block.
      yield* feed(
        me,
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Starting a worker" },
              { type: "tool_use", name: "Agent", id: "child", input: {} },
            ],
          },
        },
        10,
      )
      const otherRun = yield* agentOn(other)
      const staleRun = yield* agentOn(planner)
      const done = { type: "system", subtype: "task_notification", tool_use_id: "child", status: "completed", summary: "Ready" }
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 30 }))
      const original = (yield* waiting).agent_wait
      let end = 20
      for (const event of [
        { subtype: "task_started", tool_use_id: "child" },
        { subtype: "task_progress", tool_use_id: "child", description: "Working" },
        { subtype: "task_updated", tool_use_id: "child", patch: { status: "running" } },
        { subtype: "task_notification", tool_use_id: "shell-or-internal-agent", status: "completed" },
      ]) {
        yield* feed(me, { type: "system", ...event }, (end += 10))
        assert.deepStrictEqual((yield* reload(planner.id)).agent_wait, original)
      }
      // Another run's, or a stale run's of the same task: not this wait's.
      yield* feed(staleRun, done, 10)
      yield* feed(otherRun, done, 10)
      assert.deepStrictEqual((yield* reload(planner.id)).agent_wait, original)
      yield* feed(me, done, (end += 10))
      // The first completion wins even if several children finish together.
      yield* feed(me, { type: "system", subtype: "task_notification", tool_use_id: "child", status: "failed" }, (end += 10))
      const v = ok(yield* Fiber.join(f))
      assert.strictEqual(v["ended"], "subagent_finished")
      assert.deepStrictEqual(v["subagent"], { status: "completed", summary: "Ready", task_id: null, tool_use_id: "child" })
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a subagent's completion is kept until a retried wait returns", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* running()
      yield* feed(me, { type: "assistant", message: { content: [{ type: "tool_use", name: "Task", id: "child", input: {} }] } }, 10)
      yield* feed(me, { type: "system", subtype: "task_started", tool_use_id: "child", task_id: "background" }, 20)
      // The wait of call c1 is stored (the server stopped while it waited).
      yield* change(planner.id, {
        agent_wait: {
          reason: null,
          since: (yield* reload(planner.id)).created_at,
          until: (yield* reload(planner.id)).created_at,
          tasks: [],
          call_id: "c1",
          run_id: me.run.id,
        },
      })
      // Claude can name a background child by its task_id instead of its tool_use_id.
      yield* feed(me, { type: "system", subtype: "task_notification", task_id: "background", status: "completed", summary: "Report" }, 30)
      assert.isDefined((yield* reload(planner.id)).agent_wait?.subagent_finished)
      const v = ok(yield* call(me, "wait", { reason: "r", seconds: 30 }, "c1"))
      assert.deepStrictEqual([v["ended"], v["note"]], ["subagent_finished", "A subagent finished (see subagent)."])
      assert.deepStrictEqual(v["subagent"], { status: "completed", summary: "Report", task_id: "background", tool_use_id: "child" })
      // A new wait doesn't replay an old completion.
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 1 }, "c2"))
      yield* waiting
      yield* TestClock.adjust("1 second")
      assert.strictEqual(endedOf(ok(yield* Fiber.join(f))), "timeout")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a turn's end ends its run's wait", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* running()
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 30 }))
      yield* waiting
      yield* feed(me, { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" }, 10)
      assert.strictEqual(endedOf(ok(yield* Fiber.join(f))), "resumed")
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a later wait still sees a change (HA-341)", () =>
    Effect.gen(function* () {
      const { planner, other, me } = yield* running()
      const args = { reason: "r", tasks: [other.id], seconds: 1 }
      let waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", args))
      yield* waiting
      yield* TestClock.adjust("1 second")
      assert.strictEqual(endedOf(ok(yield* Fiber.join(f))), "timeout")
      waiting = yield* waitingOn(planner.id)
      const g = yield* Effect.forkChild(call(me, "wait", { ...args, seconds: 600 }))
      yield* waiting
      yield* change(other.id, { status: "in_review" })
      assert.strictEqual(endedOf(ok(yield* Fiber.join(g))), "tasks_changed")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )
})

describe("a wait's command", () => {
  it.effect("ends the wait when it exits, with its code and the end of its output", () =>
    allowed(
      Effect.gen(function* () {
        const { kiw, planner, me } = yield* running()
        const repo = yield* repoOf(kiw)
        let v = ok(yield* call(me, "wait", { reason: "r", command: "touch here; echo ready; echo oops >&2; exit 3", seconds: 60 }))
        assert.deepStrictEqual([v["ended"], v["command"]], ["command_exited", { exit_code: 3, output: "ready\noops\n" }])
        assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(`${repo}/here`).pipe(Effect.orDie))
        assert.isNull((yield* reload(planner.id)).agent_wait)
        // Only the end of a long output.
        v = ok(yield* call(me, "wait", { reason: "r", command: "head -c 10000 /dev/zero | tr '\\0' x; echo; echo end", seconds: 60 }))
        assert.strictEqual(at(v, "command", "exit_code"), 0)
        const output = String(at(v, "command", "output"))
        assert.isTrue(output.startsWith("… [6005 bytes before this]\n") && output.endsWith("xx\nend\n"), output)
      }),
    ),
  )

  it.effect("runs with the task's TMPDIR", () =>
    allowed(
      Effect.gen(function* () {
        // HA-301: HA-295 waited on `until grep -q ... $TMPDIR/webtest.log` for its tests' log, which its Bash calls had
        // written to the task's temp folder; the command didn't have that TMPDIR, so it looked elsewhere until a message
        // ended the wait.
        const { kiw, planner, me } = yield* running()
        yield* repoOf(kiw)
        const tmp = yield* (yield* TaskTmp).ensure(yield* reload(planner.id))
        assert.isNotNull(tmp)
        yield* (yield* FileSystem.FileSystem).writeFileString(`${tmp}/ready`, "").pipe(Effect.orDie)
        const v = ok(yield* call(me, "wait", { reason: "r", command: 'echo "$TMPDIR"; until test -f "$TMPDIR/ready"; do sleep 0.05; done', seconds: 30 }))
        assert.deepStrictEqual(v["command"], { exit_code: 0, output: `${tmp}\n` })
      }),
    ),
  )

  it.live("is stopped with everything it started when the wait ends otherwise", () =>
    allowed(
      Effect.gen(function* () {
        const { kiw, me } = yield* running()
        const repo = yield* repoOf(kiw)
        // Something it started in the background, as well as the shell itself.
        const v = ok(yield* call(me, "wait", { reason: "r", command: "sleep 30 & echo $! > pid; echo still waiting; sleep 30", seconds: 1 }))
        assert.strictEqual(v["ended"], "timeout")
        // What it printed so far comes back, to show how it was doing.
        assert.deepStrictEqual(v["command"], { stopped: true, output: "still waiting\n" })
        const pid = (yield* (yield* FileSystem.FileSystem).readFileString(`${repo}/pid`).pipe(Effect.orDie)).trim()
        // `tail --pid` ends once the process is gone.
        const gone = yield* (yield* Proc).run("tail", ["-s", "0.01", "--pid", pid, "-f", "/dev/null"], { timeout: "10 seconds" }).pipe(Effect.orDie)
        assert.strictEqual(gone.code, 0)
      }),
    ),
  )

  it.live("is stopped when the server goes without cleaning up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-test-" })
      // The server's end of the watchdog's pipe, which the kernel closes however the server goes.
      const go = yield* Deferred.make<void>()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // `wait` waits for its own jobs only, not the watchdog.
      const handle = yield* spawner.spawn(
        ChildProcess.make("bash", ["-c", LAUNCH, "issue-agent-wait", "sleep 30 & echo $! > pid; echo started; wait"], {
          cwd: dir,
          stdin: Stream.fromEffect(Deferred.await(go)).pipe(Stream.drain),
          stdout: "pipe",
          stderr: "ignore",
        }),
      )
      const started = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.takeUntil((s) => s.includes("started")),
        Stream.runDrain,
        Effect.forkChild,
      )
      yield* Fiber.join(started)
      const pid = (yield* fs.readFileString(`${dir}/pid`)).trim()
      // The server goes: nothing it would run to clean up runs, but its end of the pipe closes.
      yield* Deferred.succeed(go, undefined)
      yield* handle.exitCode.pipe(Effect.ignore)
      const gone = yield* (yield* Proc).run("tail", ["-s", "0.01", "--pid", pid, "-f", "/dev/null"], { timeout: "10 seconds" })
      assert.strictEqual(gone.code, 0, "the command's background process is still running")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )
})

/** The launcher, which a wait's gh shim runs (`huntaway gh-run`). */
const BIN = decodeURIComponent(new URL("../../bin/huntaway", import.meta.url).pathname)

/** `body` on a board whose wait commands are all allowed, with the fake GitHub of `state` as its gh, and `overrides`. */
const allowedOnGitHub = <A, E, R>(state: FakeGitHubState, body: Effect.Effect<A, E, R>, overrides: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
    const out = yield* body.pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked), { ghBin: fake.bin, exe: BIN, ...overrides })))
    return { out, calls: yield* fake.calls }
  }).pipe(Effect.provide(NodeServices.layer))

/** The profile's GitHub account, as its settings would set it. */
const accountOf = (profileId: string, account: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE profiles SET github_account = ${account} WHERE id = ${profileId}`).pipe(Effect.orDie)

describe("a wait's command and GitHub", () => {
  it.effect("its gh acts as the task's GitHub account, through gh-run", () =>
    Effect.gen(function* () {
      const { out, calls } = yield* allowedOnGitHub(
        {
          accounts: [
            { host: "github.com", login: "me", token: "tok-me" },
            { host: "github.com", login: "other", token: "tok-other", active: true },
          ],
          repos: { "o/r": { pulls: [{ number: 1, title: "The change", body: "", state: "OPEN", head: "x", base: "main" }] } },
        },
        Effect.gen(function* () {
          const { planner, me } = yield* running()
          yield* accountOf(planner.profile_id, "me")
          return ok(yield* call(me, "wait", { reason: "r", command: "gh pr view 1 --repo o/r --json title --jq .title", seconds: 60 }))
        }),
      )
      assert.deepStrictEqual(out["command"], { exit_code: 0, output: "The change\n" })
      const view = calls.find((c) => c.args[0] === "pr" && !c.args.includes("--help"))
      assert.strictEqual(view?.as, "me")
      assert.isFalse(view?.envToken)
    }),
  )

  it.effect("its command doesn't run as another GitHub account", () =>
    Effect.gen(function* () {
      // The profile picked an account gh isn't signed in to (or gh isn't there): the command would run as gh's active
      // account, so it doesn't run at all.
      const { out } = yield* allowedOnGitHub(
        { accounts: [{ host: "github.com", login: "other", token: "tok-other", active: true }] },
        Effect.gen(function* () {
          const { kiw, planner, me } = yield* running()
          yield* accountOf(planner.profile_id, "not-signed-in-ia123")
          const why = err(yield* call(me, "wait", { reason: "r", command: "touch ran", seconds: 60 }))
          const repo = yield* repoOf(kiw)
          return { why, ran: yield* (yield* FileSystem.FileSystem).exists(`${repo}/ran`).pipe(Effect.orDie), wait: (yield* reload(planner.id)).agent_wait }
        }),
      )
      assert.include(out.why, "not-signed-in-ia123")
      assert.isFalse(out.ran)
      assert.isNull(out.wait)
    }),
  )
})

/**
 * `body` on a board whose gh is the fake GitHub of `state` (o/r#7 read as `me`), its pull requests read every 10 ms (as
 * the old tests' `POLL` in tests), with the project's repository pushed to o/r. On the live clock: its reads are processes.
 */
const onPullRequests = <A, E, R>(
  state: FakeGitHubState,
  body: (fake: FakeGitHub, board: { readonly planner: Task; readonly me: FakeAgent }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
    return yield* Effect.gen(function* () {
      const { kiw, planner, me } = yield* running()
      yield* onGitHub(kiw)
      return yield* body(fake, { planner, me })
    }).pipe(Effect.provideService(PrPoll, "10 millis"), Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked), { ghBin: fake.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** The GraphQL reads gh was given, and as whom. */
const reads = (fake: FakeGitHub) => Effect.map(fake.calls, (calls) => calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql"))

/** The pull request's news a wait's result has: its events, and its comments' authors. */
const prNews = (v: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const news = newsOf(v["pull_request"]) ?? assert.fail(`no news: ${yield* toJson(v)}`)
    return { events: news.events, authors: (news.comments ?? []).map((c) => c.author), news }
  })

/** A wait on pull request 7, ended once `then` has run with the task showing it. */
const waitThenOn = (planner: Task, me: FakeAgent, then: (shown: Task) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const waiting = yield* waitingOn(planner.id)
    const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 }))
    yield* then(yield* waiting)
    return yield* Fiber.join(f)
  })

const pendingCheck = { name: "test", state: "IN_PROGRESS", bucket: "pending", required: true }
const failingCheck = { name: "test", state: "FAILURE", bucket: "fail", required: true, link: "https://github.com/o/r/actions/runs/0" }
const by = (id: string, author: string, body: string) => ({ id, author, body, createdAt: `2026-10-31T00:00:${id}Z` })
const FAR = Timestamp.make("2099-01-01T00:00:00.000Z")

describe("a wait on a pull request", () => {
  it.live("ends on news about its pull request", () =>
    onPullRequests(github([pull7({ checks: [pendingCheck], comments: [by("01", "alice", "old")] })]), (fake, { planner, me }) =>
      Effect.gen(function* () {
        const shown = yield* Ref.make<Task | null>(null)
        const v = ok(
          yield* waitThenOn(planner, me, (t) =>
            Effect.andThen(
              Ref.set(shown, t),
              // A check fails, someone comments, and so does the agent's own account.
              fake.update((s) => ({
                ...s,
                repos: {
                  "o/r": {
                    pulls: [pull7({ checks: [failingCheck], comments: [by("01", "alice", "old"), by("02", "me", "mine"), by("03", "bob", "Looks off")] })],
                  },
                },
              })),
            ),
          ),
        )
        assert.strictEqual(v["ended"], "pull_request")
        const { events, authors, news } = yield* prNews(v)
        assert.deepStrictEqual([events, authors], [["checks_failed", "comments"], ["bob"]])
        assert.strictEqual(news.checks?.failed[0]?.url, "https://github.com/o/r/actions/runs/0")
        assert.strictEqual(v["note"], "Pull request #7: checks failed (test); 1 new comment or review from bob (see pull_request).")
        // The board showed what it watched.
        const pr = (yield* Ref.get(shown))?.agent_wait?.pull_request
        assert.deepStrictEqual([pr?.url, pr?.repo, pr?.number, pr?.news], ["https://github.com/o/r/pull/7", "o/r", 7, undefined])
        assert.isNull((yield* reload(planner.id)).agent_wait)
        // Read as gh's account (the profile has none).
        const all = yield* reads(fake)
        assert.isTrue(all.length >= 2 && all.every((c) => c.as === "me"))

        // Told, it isn't news again.
        assert.strictEqual(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 1 }))["ended"], "timeout")
        // A review left while the agent worked between waits ends the next one straight away.
        yield* fake.update((s) => ({
          ...s,
          repos: {
            "o/r": {
              pulls: [pull7({ checks: [failingCheck], comments: [by("01", "alice", "old"), by("03", "bob", "Looks off"), by("04", "carol", "Approve?")] })],
            },
          },
        }))
        const next = yield* prNews(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 })))
        assert.deepStrictEqual([next.events, next.authors], [["comments"], ["carol"]])
        // Merged ends it whatever it waits for.
        yield* fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [pull7({ state: "MERGED" })] } } }))
        const merged = yield* prNews(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", pull_request_events: [], seconds: 30 })))
        assert.deepStrictEqual(merged.events, ["merged"])
      }),
    ),
  )

  it.live("a wait on checks ends when its pull request conflicts and none will run (HA-287)", () =>
    onPullRequests(github([pull7({ mergeable: "CONFLICTING" })]), (fake, { me }) =>
      Effect.gen(function* () {
        const first = yield* prNews(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 })))
        assert.deepStrictEqual(first.events, ["conflicts"])
        assert.strictEqual(first.news.mergeable, "conflicting")
        // Still conflicting, the next wait on checks ends too.
        assert.deepStrictEqual((yield* prNews(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 })))).events, ["conflicts"])
        // Checks that are running end it themselves.
        yield* fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [pull7({ mergeable: "CONFLICTING", checks: [pendingCheck] })] } } }))
        assert.strictEqual(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 1 }))["ended"], "timeout")
      }),
    ),
  )

  it.live("a pull request that can't be read doesn't start the wait", () =>
    onPullRequests(github([pull7({ unreadable: "Could not resolve to a Repository with the name 'o/r'." })]), (_fake, { planner, me }) =>
      Effect.gen(function* () {
        assert.strictEqual(
          err(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 })),
          "The wait didn't start: o/r#7 couldn't be read: Could not resolve to a Repository with the name 'o/r'.",
        )
        assert.isNull((yield* reload(planner.id)).agent_wait)
        // A host from the task's remote that isn't GitHub's (an SSH alias ssh doesn't know) asks for the URL.
        yield* setOrigin(planner, "git@github-work:o/r.git")
        const e = err(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 30 }))
        assert.isTrue(
          e.startsWith("The wait didn't start: github-work/o/r#7 couldn't be read: ") &&
            e.endsWith(" (if github-work isn't a GitHub host, give the pull request's URL)"),
          e,
        )
      }),
    ),
  )

  it.live("its pull request is read as the task's GitHub account only", () =>
    onPullRequests(
      {
        accounts: [
          { host: "github.com", login: "me-personal", token: "tok-p", active: true },
          { host: "github.com", login: "me-work", token: "tok-w" },
        ],
        repos: { "o/r": { pulls: [pull7()] } },
      },
      (fake, { planner, me }) =>
        Effect.gen(function* () {
          // The personal profile's agents act as one account; it asks for a pull request only the work account sees.
          yield* accountOf(planner.profile_id, "me-personal")
          const e = err(yield* call(me, "wait", { reason: "r", pull_request: "https://github.com/work-org/secret/pull/7", seconds: 30 }))
          assert.isTrue(e.includes("couldn't be read: Could not resolve"), e)
          assert.deepStrictEqual(
            (yield* reads(fake)).map((c) => c.as),
            ["me-personal"],
          )
          // Nor is one on another host than its account's asked for at all.
          yield* accountOf(planner.profile_id, "ghe.acme.com/me")
          const other = err(yield* call(me, "wait", { reason: "r", pull_request: "https://github.com/work-org/secret/pull/7" }))
          assert.isTrue(other.includes("is on github.com, but this task's GitHub account ghe.acme.com/me is on ghe.acme.com"), other)
          assert.strictEqual((yield* reads(fake)).length, 1)
          // A profile whose account isn't gh's active one reads as that account.
          yield* accountOf(planner.profile_id, "me-work")
          assert.strictEqual(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 1 }))["ended"], "timeout")
          const asWork = (yield* reads(fake)).slice(1)
          assert.isTrue(asWork.length >= 2 && asWork.every((c) => c.as === "me-work"), asWork.map((c) => c.as).join())
        }),
    ),
  )

  it.live("a pull request wait carried on after a restart keeps what was seen", () =>
    onPullRequests(github([pull7({ comments: [by("01", "alice", "old")] })]), (fake, { planner, me }) =>
      Effect.gen(function* () {
        // A first wait sees alice's comment.
        assert.strictEqual(ok(yield* call(me, "wait", { reason: "r", pull_request: "7", seconds: 1 }))["ended"], "timeout")
        // The server restarts during the next one, and bob comments meanwhile.
        const stored = (callId: string, news?: unknown): AgentWait => ({
          reason: "waiting for review",
          since: Timestamp.make(AT(0)),
          until: FAR,
          tasks: [],
          call_id: callId,
          run_id: me.run.id,
          pull_request: { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, events: [...EVENTS], ...(news === undefined ? {} : { news }) },
        })
        yield* change(planner.id, { agent_wait: stored("c2") })
        yield* fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [pull7({ comments: [by("01", "alice", "old"), by("02", "bob", "new")] })] } } }))
        const v = ok(yield* call(me, "wait", { reason: "r", seconds: 30 }, "c2"))
        assert.deepStrictEqual((yield* prNews(v)).authors, ["bob"])
        // News found before a restart is returned without reading again.
        const before = (yield* reads(fake)).length
        const news = { events: ["closed"], number: 7 }
        yield* change(planner.id, { agent_wait: stored("c3", news) })
        const again = ok(yield* call(me, "wait", { reason: "r", seconds: 30 }, "c3"))
        assert.deepStrictEqual([again["ended"], again["pull_request"]], ["pull_request", news])
        assert.strictEqual((yield* reads(fake)).length, before)
      }),
    ),
  )

  it.live("news that doesn't reach the agent is reported again", () =>
    onPullRequests(github([pull7({ checks: [failingCheck] })]), (_fake, { planner, me }) =>
      Effect.gen(function* () {
        // A read for the wait c1 found the failure, and then the run was stopped.
        const prWatch = yield* PrWatch
        const now = yield* reload(planner.id)
        const reader = yield* prWatch.readerOf(now, { host: "github.com", owner: "o", name: "r", number: 7 })
        const news = yield* prWatch.poll(planner.id, "c1", [...EVENTS], reader).pipe(Effect.orDie)
        assert.isNotNull(news)
        yield* change(planner.id, {
          agent_wait: {
            reason: null,
            since: Timestamp.make(AT(0)),
            until: FAR,
            tasks: [],
            call_id: "c1",
            run_id: me.run.id,
            pull_request: { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, events: [...EVENTS], ...(news === null ? {} : { news }) },
          },
        })
        yield* (yield* RunRepo).update(me.run.id, { stop: "requested" })
        assert.strictEqual(ok(yield* call(me, "wait", { reason: "r", seconds: 30 }, "c1"))["ended"], "stopped")
        // The next run's wait is told.
        const next = yield* agentOn(now)
        assert.deepStrictEqual((yield* prNews(ok(yield* call(next, "wait", { reason: "r", pull_request: "7", seconds: 30 })))).events, ["checks_failed"])
        assert.strictEqual(ok(yield* call(next, "wait", { reason: "r", pull_request: "7", seconds: 1 }))["ended"], "timeout")
      }),
    ),
  )

  it.live("a pull request that stops being readable ends the wait", () =>
    onPullRequests(github([pull7()]), (fake, { planner, me }) =>
      Effect.gen(function* () {
        const v = ok(
          yield* waitThenOn(planner, me, () => fake.update((s) => ({ ...s, repos: { "o/r": { pulls: [pull7({ unreadable: "HTTP 502: Bad Gateway" })] } } }))),
        )
        assert.deepStrictEqual((yield* prNews(v)).events, ["unreadable"])
        assert.strictEqual((yield* reads(fake)).length, 1 + GIVE_UP)
        assert.strictEqual(
          v["note"],
          "o/r#7 couldn't be read 5 times in a row: HTTP 502: Bad Gateway. Check it yourself (pr_view), and wait on it again once it can be read.",
        )
      }),
    ),
  )
})
