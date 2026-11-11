import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Ref, Schema } from "effect"
import type { Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { CallId, Timestamp } from "@huntaway/contracts"
import { Actor } from "../../platform/Changes.ts"
import { toJson } from "../../platform/columns.ts"
import { BackgroundWork } from "../../runs/BackgroundWork.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { McpServers } from "../McpServers.ts"
import { controlCallId, ToolCalls } from "../ToolCalls.ts"
import type { CommandAnswer, CommandApproval, CommandInput } from "../wait/CommandApproval.ts"
import { COMMAND_STOPPED } from "../wait/ended.ts"
import { agentOn, at, call, err, ok, profile, project, task } from "./tests/board.ts"
import { approvalOf, change, feed, reload, repoOf, review, ServerAgain, WaitBoard, waitingOn } from "./tests/wait.ts"
import { BACKGROUND_NOT_WAITING, BACKGROUND_WAITING, NO_PR_WATCH } from "./wait.ts"

// The `wait` and `background_wait` tools as an agent calls them through `ToolCalls` (the wait cases of the old
// mcp/tools/dispatch.test.ts and agent/runner/requests.test.ts, and background_wait's of runner/background.test.ts).
// Dropped, with why:
// - Codex's endings of a subagent and Codex runs whose reviewer reviews waits: Codex is M5;
// - Don't ask refusing a wait's command without asking: that is `Permissions`' answer (3.3), behind `CommandApproval`;
// - `an_agent_waits_on_its_pull_request`: watching pull requests is plan task 4.5; until then the wait is refused.

/** A project KIW with a planner (KIW-1) whose agent is running, and a worker (KIW-2) it can watch. */
const kiwi = Effect.gen(function* () {
  const p = yield* profile("personal")
  const kiw = yield* project(p, "kiwicd", "KIW")
  const planner = yield* task(kiw, "Plan")
  const worker = yield* task(kiw, "Build")
  const me = yield* agentOn(planner)
  return { kiw, planner, worker, me }
})

const AnObject = Schema.Record(Schema.String, Schema.Unknown)
/** The first watched task of a wait's result. */
const first = (v: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const tasks = v["tasks"]
  const t = Array.isArray(tasks) ? tasks[0] : undefined
  return Schema.is(AnObject)(t) ? t : assert.fail("no task in the result")
}

const T0 = "2026-11-10T04:12:35.000Z"

/** `body` on a server of its own over the board (built afresh: a restart is another), with `approval`. */
const onServer = <A, E, R>(body: Effect.Effect<A, E, R>, approval?: Layer.Layer<CommandApproval>) =>
  body.pipe(Effect.scoped, Effect.provide(ServerAgain(approval)))

/** Allows every command but `true`. */
const allowButTrue = (input: CommandInput): CommandAnswer => (input.command === "true" ? { allowed: false, message: null } : { allowed: true })

describe("wait", () => {
  it.effect("is listed where the old server listed it, with its arguments and the bounds of seconds", () =>
    Effect.gen(function* () {
      const tools = yield* (yield* McpServers).tools("huntaway", false)
      assert.deepStrictEqual(
        tools.slice(0, 7).map((t) => t.name),
        ["request_user_input", "finish_work", "track_work", "untrack_work", "list_tracked_work", "wait", "background_wait"],
      )
      const wait = tools.find((t) => t.name === "wait")
      assert.deepStrictEqual(Object.keys(Object(at(wait?.inputSchema, "properties"))), [
        "reason",
        "seconds",
        "tasks",
        "last_seen",
        "pull_request",
        "pull_request_events",
        "command",
      ])
      assert.deepStrictEqual(at(wait?.inputSchema, "required"), ["reason"])
      assert.deepStrictEqual([at(wait?.inputSchema, "properties", "seconds", "minimum"), at(wait?.inputSchema, "properties", "seconds", "maximum")], [1, 3600])
      const reviewers = new Set((yield* (yield* McpServers).tools("huntaway", true)).map((t) => t.name))
      assert.isTrue(reviewers.has("wait") && reviewers.has("background_wait"))
    }).pipe(Effect.provide(WaitBoard())),
  )

  it.effect("an agent waits for the tasks it watches", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      assert.include(err(yield* call(me, "wait", { reason: "r", tasks: ["KIW-9"] })), "task KIW-9 not found on this host")
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "waiting on KIW-2", tasks: ["KIW-2"], seconds: 60 }, "c1"))
      const shown = yield* waiting
      assert.deepStrictEqual(
        shown.agent_wait?.tasks.map((t) => [t.key, t.status]),
        [["KIW-2", "todo"]],
      )
      yield* (yield* Tasks).update(worker.id, { status: "in_review" }, Actor.user)
      const v = ok(yield* Fiber.join(f))
      assert.strictEqual(v["ended"], "tasks_changed")
      assert.strictEqual(v["note"], "KIW-2 changed status (see tasks).")
      assert.deepStrictEqual([first(v)["key"], first(v)["status"]], ["KIW-2", "in_review"])
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  // HA-390: a review that passes leaves its task in in_review, so a wait that only looked at the status slept on until
  // its time was up.
  it.effect("a wait on a task in review ends when its review passes, and gives only the review's state", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      yield* change(worker.id, { status: "in_review", review: review(worker.id, "running", "2026-11-10T00:00:00.000Z") })
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "waiting on KIW-2's review", tasks: ["KIW-2"], seconds: 60 }))
      yield* waiting
      yield* change(worker.id, { review: review(worker.id, "passed", "2026-11-10T00:05:00.000Z") })
      const v = ok(yield* Fiber.join(f))
      assert.strictEqual(v["ended"], "tasks_changed")
      assert.strictEqual(v["note"], "KIW-2's review passed (see tasks).")
      assert.deepStrictEqual([first(v)["key"], first(v)["status"], first(v)["review"]], ["KIW-2", "in_review", { state: "passed" }])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  // HA-389: HA-346's agent read HA-376 as in progress, HA-376 went to In review 11 seconds before the agent's wait on it
  // started, and its review passed during the wait. The wait watched only its status, so it sat on until a message came.
  it.effect("a wait on a task ends when its review ends, but not on a round that ended before it", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      yield* change(worker.id, { status: "in_review", review: review(worker.id, "running", T0) })
      const waitFor = <R>(id: string, seconds: number, then: Effect.Effect<void, never, R>) =>
        Effect.gen(function* () {
          const waiting = yield* waitingOn(planner.id)
          const f = yield* Effect.forkChild(call(me, "wait", { reason: "waiting for KIW-2 to be reviewed", tasks: ["KIW-2"], seconds }, id))
          yield* waiting
          yield* then
          return ok(yield* Fiber.join(f))
        })
      for (const [n, ending] of (["passed", "issues"] as const).entries()) {
        const v = yield* waitFor(`c${n}`, 30, change(worker.id, { review: review(worker.id, ending, `2026-11-10T04:2${n}:00.000Z`) }))
        assert.strictEqual(v["ended"], "tasks_changed")
        assert.strictEqual(v["note"], `KIW-2's review ${ending === "passed" ? "passed" : "found issues"} (see tasks).`)
        assert.deepStrictEqual([first(v)["status"], at(first(v), "review", "state")], ["in_review", ending])
        // Back to running for the next round.
        yield* change(worker.id, { review: review(worker.id, "running", `2026-11-10T04:3${n}:00.000Z`) })
      }
      // A review that had ended when the wait started doesn't end it, but the next round's end does, even with the same outcome.
      yield* change(worker.id, { review: review(worker.id, "passed", "2026-11-10T04:40:00.000Z") })
      let v = yield* waitFor("c2", 1, TestClock.adjust("1 second"))
      assert.strictEqual(v["ended"], "timeout")
      v = yield* waitFor(
        "c3",
        30,
        Effect.andThen(
          change(worker.id, { review: review(worker.id, "running", "2026-11-10T05:00:00.000Z") }),
          change(worker.id, { review: review(worker.id, "passed", "2026-11-10T05:10:00.000Z") }),
        ),
      )
      assert.strictEqual(v["note"], "KIW-2's review passed (see tasks).")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  // HA-389: a task that changed between the agent's last read and its wait ends the wait at once if the agent says what it saw.
  it.effect("a wait on a task starts from the status the agent last saw", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      yield* change(worker.id, { status: "in_review" })
      let v = ok(yield* call(me, "wait", { reason: "r", tasks: ["KIW-2"], last_seen: { "KIW-2": "in_progress" }, seconds: 30 }))
      assert.deepStrictEqual([v["ended"], v["note"], first(v)["status"]], ["tasks_changed", "KIW-2 changed status (see tasks).", "in_review"])
      // By id too; the same status it has now waits as before.
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", tasks: [worker.id], last_seen: { "KIW-2": "in_review" }, seconds: 0.5 }))
      yield* waiting
      yield* TestClock.adjust("1 second")
      v = ok(yield* Fiber.join(f))
      assert.strictEqual(v["ended"], "timeout")
      assert.include(
        err(yield* call(me, "wait", { reason: "r", tasks: ["KIW-2"], last_seen: { "KIW-1": "todo" } })),
        "last_seen has KIW-1, which isn't in tasks",
      )
      // A status that isn't one, a list, a review state that isn't one: the arguments' schema refuses them.
      for (const lastSeen of [{ "KIW-2": "finished" }, ["in_progress"], { "KIW-2": { status: "in_review", review: "done" } }]) {
        assert.include(
          err(yield* call(me, "wait", { reason: "r", tasks: ["KIW-2"], last_seen: lastSeen, seconds: 30 })),
          "wait's arguments don't fit its schema",
        )
      }
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  // HA-389 review: the agent reads KIW-2 in review with its review running, the review passes before its wait call comes
  // in, and the wait would watch it from "passed" for its whole period. Saying the review state it saw ends it at once.
  it.effect("a wait on a task starts from the review the agent last saw", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      const lastSeen = (seen: unknown, seconds = 30) => call(me, "wait", { reason: "r", tasks: ["KIW-2"], last_seen: { "KIW-2": seen }, seconds })
      yield* change(worker.id, { status: "in_review", review: review(worker.id, "running", T0) })
      // Read by the agent; then the review passes.
      yield* change(worker.id, { review: review(worker.id, "passed", "2026-11-10T04:20:00.000Z") })
      let v = ok(yield* lastSeen({ status: "in_review", review: "running" }))
      assert.deepStrictEqual([v["ended"], v["note"], at(first(v), "review", "state")], ["tasks_changed", "KIW-2's review passed (see tasks).", "passed"])
      // A task the agent saw with no review, whose review has since ended, too; a status alone keeps the review as it is.
      v = ok(yield* lastSeen({ status: "in_review", review: null }))
      assert.strictEqual(v["note"], "KIW-2's review passed (see tasks).")
      // The review state it has now waits on, as does a status alone (the review as it is now), or the review alone.
      for (const seen of ["in_review", { status: "in_review", review: "passed" }, { review: "passed" }]) {
        const waiting = yield* waitingOn(planner.id)
        const f = yield* Effect.forkChild(lastSeen(seen, 0.3))
        yield* waiting
        yield* TestClock.adjust("1 second")
        assert.strictEqual(ok(yield* Fiber.join(f))["ended"], "timeout", yield* toJson(seen))
      }
      // A status that's moved on still ends it, with the review given too.
      v = ok(yield* lastSeen({ status: "in_progress", review: "passed" }))
      assert.strictEqual(v["note"], "KIW-2 changed status (see tasks).")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("another call from the run ends its wait", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* kiwi
      // Without tasks or a command, a long wait is turned down.
      const e = err(yield* call(me, "wait", { reason: "r", seconds: 600 }))
      assert.isTrue(e.startsWith("The wait didn't start") && e.includes("30 seconds at most"), e)
      assert.isNull((yield* reload(planner.id)).agent_wait)
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "r", seconds: 30 }, "c1"))
      yield* waiting
      // The agent works on while the wait is pending (Claude Code runs its calls concurrently).
      ok(yield* call(me, "get_task", { task_id: "KIW-1" }))
      const v = ok(yield* Fiber.join(f))
      assert.deepStrictEqual([v["ended"], v["note"]], ["resumed", "The wait ended because you carried on with other work (another tool call)."])
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a subagent's completion wakes its agent's wait, and its turn goes on", () =>
    Effect.gen(function* () {
      const { kiw } = yield* kiwi
      const endings = [
        { type: "system", subtype: "task_notification", tool_use_id: "child", task_id: "background", status: "completed", summary: "Child report" },
        { type: "system", subtype: "task_updated", tool_use_id: "child", patch: { status: "failed" } },
      ]
      for (const [n, ending] of endings.entries()) {
        const planner = yield* task(kiw, `Plan ${n}`)
        const me = yield* agentOn(planner)
        const start = {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "child", name: "Agent", input: { description: "Inspect config", run_in_background: true } }] },
        }
        yield* feed(me, start, 10)
        const waiting = yield* waitingOn(planner.id)
        const f = yield* Effect.forkChild(call(me, "wait", { reason: "waiting for child", seconds: 1 }))
        yield* waiting
        yield* feed(me, ending, 20)
        const v = ok(yield* Fiber.join(f))
        assert.strictEqual(v["ended"], "subagent_finished", `case ${n}`)
        assert.strictEqual(at(v, "subagent", "tool_use_id"), "child")
        assert.strictEqual(v["note"], "A subagent finished (see subagent).")
        assert.isNull((yield* reload(planner.id)).agent_wait)
        assert.isFalse((yield* me.row).saw_result, "the parent's turn must stay running")
      }
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a wait's command is approved like a Bash call", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
      yield* Effect.gen(function* () {
        const { kiw, planner, me } = yield* kiwi
        const repo = yield* repoOf(kiw)
        const v = ok(yield* call(me, "wait", { reason: "waiting for the build", command: "pwd; exit 1", seconds: 60 }))
        assert.deepStrictEqual(yield* Ref.get(asked), [{ command: "pwd; exit 1", cwd: repo, description: "Run while waiting: waiting for the build" }])
        assert.deepStrictEqual([v["ended"], v["note"]], ["command_exited", "Your command exited with code 1 (see command.output)."])
        assert.deepStrictEqual(v["command"], { exit_code: 1, output: `${repo}\n` })
        const e = err(yield* call(me, "wait", { reason: "r", command: "true" }))
        assert.strictEqual(e, "The command wasn't approved, so the wait didn't start: denied")
        assert.isNull((yield* reload(planner.id)).agent_wait)
      }).pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked, allowButTrue))))
    }),
  )

  // HA-301: one that's still running when the wait is over is stopped, and says what it printed so far.
  it.live("a wait's command still running at the end of the wait is stopped, and its output so far returned", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
      yield* Effect.gen(function* () {
        const { kiw, me } = yield* kiwi
        yield* repoOf(kiw)
        const v = ok(yield* call(me, "wait", { reason: "r", command: "echo not yet; sleep 30", seconds: 1 }))
        assert.strictEqual(v["ended"], "timeout")
        assert.isTrue(String(v["note"]).endsWith(` ${COMMAND_STOPPED}`), String(v["note"]))
        assert.deepStrictEqual(v["command"], { stopped: true, output: "not yet\n" })
      }).pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked))))
    }),
  )

  it.effect("a wait's command runs unasked when the agent's reviewer approved the call", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
      yield* Effect.gen(function* () {
        const { kiw, planner } = yield* kiwi
        const repo = yield* repoOf(kiw)
        const launched = (mode: string, allowed: string) =>
          Effect.gen(function* () {
            const me = yield* agentOn(planner)
            const args = ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"]
            yield* (yield* RunDir).writeSpec(me.run.id, { args, config_dir: null, cwd: repo }).pipe(Effect.orDie)
            return me
          })
        // Claude's auto mode classifier approved the call before the agent made it.
        let me = yield* launched("auto", "mcp__huntaway__get_task")
        const v = ok(yield* call(me, "wait", { reason: "waiting for CI", command: "exit 3" }))
        assert.deepStrictEqual([v["ended"], at(v, "command", "exit_code")], ["command_exited", 3])
        assert.deepStrictEqual(yield* Ref.get(asked), [])
        // A run that pre-approves every board tool (one from an older build, before or after the rename) is still asked,
        // in auto mode as in Ask.
        for (const [mode, allowed] of [
          ["auto", "mcp__huntaway"],
          ["auto", "mcp__issue_agent"],
          ["default", "mcp__issue_agent"],
        ] as const) {
          me = yield* launched(mode, allowed)
          ok(yield* call(me, "wait", { reason: "waiting for CI", command: "exit 3" }))
        }
        assert.strictEqual((yield* Ref.get(asked)).length, 3)
      }).pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked))))
    }),
  )

  it.effect("a wait on a pull request is refused until the board watches them", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* kiwi
      assert.strictEqual(err(yield* call(me, "wait", { reason: "CI", pull_request: "#7" })), NO_PR_WATCH)
      // A blank one is none.
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(call(me, "wait", { reason: "CI", pull_request: " ", seconds: 1 }))
      yield* waiting
      yield* TestClock.adjust("1 second")
      assert.strictEqual(ok(yield* Fiber.join(f))["ended"], "timeout")
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a restart picks the stored wait up: its deadline and watched tasks", () =>
    Effect.gen(function* () {
      const { planner, worker, me } = yield* kiwi
      const args = { reason: "r", tasks: ["KIW-2"], seconds: 60 }
      yield* onServer(
        Effect.gen(function* () {
          const waiting = yield* waitingOn(planner.id)
          yield* Effect.forkChild(call(me, "wait", args, "c1"))
          yield* waiting
        }),
      )
      // The server went with the call waiting: the wait stays shown, with its deadline.
      assert.strictEqual((yield* reload(planner.id)).agent_wait?.call_id, "c1")
      yield* TestClock.adjust("50 seconds")
      // The agent's client retries the call: it ends when it would have, not 60 seconds after the restart.
      yield* onServer(
        Effect.gen(function* () {
          const f = yield* Effect.forkChild(call(me, "wait", args, "c1"))
          yield* TestClock.adjust("10 seconds")
          assert.strictEqual(ok(yield* Fiber.join(f))["ended"], "timeout")
        }),
      )
      assert.isNull((yield* reload(planner.id)).agent_wait)
      // The watched task changed while the server was down: the retried call ends at once.
      yield* onServer(
        Effect.gen(function* () {
          const waiting = yield* waitingOn(planner.id)
          yield* Effect.forkChild(call(me, "wait", args, "c2"))
          yield* waiting
        }),
      )
      yield* change(worker.id, { status: "done" })
      const v = yield* onServer(call(me, "wait", args, "c2"))
      assert.deepStrictEqual([ok(v)["ended"], ok(v)["note"]], ["tasks_changed", "KIW-2 changed status (see tasks)."])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.live("a restart starts the stored wait's command again", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<CommandInput>>([])
      yield* Effect.gen(function* () {
        const { kiw, planner, me } = yield* kiwi
        const repo = yield* repoOf(kiw)
        const args = { reason: "r", command: "until test -f go; do sleep 0.05; done; echo went", seconds: 600 }
        yield* onServer(
          Effect.gen(function* () {
            const waiting = yield* waitingOn(planner.id)
            yield* Effect.forkChild(call(me, "wait", args, "c1"))
            yield* waiting
          }),
          approvalOf(asked),
        )
        // Its command went with the server; once what it waits for is there, the retried call runs it again.
        yield* (yield* FileSystem.FileSystem).writeFileString(`${repo}/go`, "").pipe(Effect.orDie)
        const v = ok(yield* onServer(call(me, "wait", args, "c1"), approvalOf(asked)))
        assert.deepStrictEqual([v["ended"], v["command"]], ["command_exited", { exit_code: 0, output: "went\n" }])
        // Asked once: the retried call was approved when it was first made.
        assert.strictEqual((yield* Ref.get(asked)).length, 1)
      }).pipe(Effect.scoped, Effect.provide(WaitBoard(approvalOf(asked))))
    }),
  )

  it.effect("a wait carries on over a restart, and is answered on the run's input", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* kiwi
      const sql = yield* SqlClient.SqlClient
      // A wait that was going when the server stopped, with its deadline.
      const id = controlCallId(me.run.id, "w1")
      const saved = yield* toJson({ request_id: "w1", rpc_id: 21, arguments: { seconds: 20, reason: "CI" } })
      yield* sql`INSERT INTO mcp_calls (id, run_id, task_id, tool, args, status, created_at)
        VALUES (${id}, ${me.run.id}, ${planner.id}, 'wait', ${saved}, 'executing', '2026-11-06T00:00:00Z')`.pipe(Effect.orDie)
      const since = Timestamp.make("1970-01-01T00:00:00.000Z")
      yield* change(planner.id, {
        agent_wait: { reason: "CI", since, until: Timestamp.make("1970-01-01T00:00:00.600Z"), tasks: [], call_id: id, run_id: me.run.id },
      })
      const calls = yield* ToolCalls
      yield* calls.resume
      // It ends when it would have, not 20 seconds after the restart; a delivery of the call meanwhile waits for it.
      const f = yield* Effect.forkChild(
        calls.call({
          call_id: id,
          run: me.run.id,
          server: "huntaway",
          tool: "wait",
          args: { seconds: 20, reason: "CI" },
          answer: { request_id: "w1", rpc_id: 21 },
        }),
      )
      yield* TestClock.adjust("600 millis")
      const result = yield* Fiber.join(f)
      assert.strictEqual(ok(result)["ended"], "timeout")
      const answers = (yield* me.input).filter((l) => at(l, "response", "request_id") === "w1")
      assert.strictEqual(answers.length, 1)
      assert.strictEqual(at(answers[0], "response", "response", "mcp_response", "id"), 21)
      assert.isNull((yield* reload(planner.id)).agent_wait)
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )

  it.effect("a wait Claude cancels ends unanswered", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* kiwi
      const calls = yield* ToolCalls
      const id = controlCallId(me.run.id, "w1")
      const waiting = yield* waitingOn(planner.id)
      const f = yield* Effect.forkChild(
        calls.call({
          call_id: id,
          run: me.run.id,
          server: "huntaway",
          tool: "wait",
          args: { seconds: 20, reason: "CI" },
          answer: { request_id: "w1", rpc_id: 3 },
        }),
      )
      assert.strictEqual((yield* waiting).agent_wait?.call_id, id)
      // Another call's cancel leaves it waiting.
      yield* calls.cancel(me.run.id, CallId.make(controlCallId(me.run.id, "w2")))
      assert.strictEqual((yield* reload(planner.id)).agent_wait?.call_id, id)
      yield* calls.cancel(me.run.id, id)
      yield* Fiber.join(f)
      assert.isNull((yield* reload(planner.id)).agent_wait)
      // The wait itself isn't answered.
      assert.deepStrictEqual(yield* me.input, [])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )
})

/** A background shell as the task shows it. */
describe("background_wait", () => {
  it.effect("records the shells the agent waits on, among those it has going", () =>
    Effect.gen(function* () {
      const { planner, me } = yield* kiwi
      const dirs = yield* RunDir
      // None going.
      assert.strictEqual(
        err(yield* call(me, "background_wait", { task_id: "b1" })),
        'You have no background task "b1" going. Pass the ID the Bash tool gave back when it started the command in the background; you have none going.',
      )
      // What Claude Code listed (the run's `background` file), shown on the task.
      const background = yield* BackgroundWork
      yield* background.setTasks(me.run.id, [
        { id: "b1", type: "local_bash", description: "Build", since: null, command: "make" },
        { id: "b2", type: "local_bash", description: null, since: null, command: "make" },
      ])
      yield* background.sync(me.run.id)
      assert.isNotNull((yield* reload(planner.id)).background_work)
      assert.strictEqual(
        err(yield* call(me, "background_wait", { task_id: "b9" })),
        'You have no background task "b9" going. Pass the ID the Bash tool gave back when it started the command in the background; yours are b1 (Build), b2 (make).',
      )
      assert.deepStrictEqual(ok(yield* call(me, "background_wait", { task_id: " b1 " })), { ok: true, note: BACKGROUND_WAITING })
      assert.deepStrictEqual(ok(yield* call(me, "background_wait", { task_id: "b2" })), { ok: true, note: BACKGROUND_WAITING })
      assert.deepStrictEqual(yield* dirs.backgroundWaited(me.run.id), ["b1", "b2"])
      assert.deepStrictEqual(ok(yield* call(me, "background_wait", { task_id: "b1", waiting: false })), { ok: true, note: BACKGROUND_NOT_WAITING })
      assert.deepStrictEqual(yield* dirs.backgroundWaited(me.run.id), ["b2"])
      yield* call(me, "background_wait", { task_id: "b2", waiting: false })
      assert.deepStrictEqual(yield* dirs.backgroundWaited(me.run.id), [])
    }).pipe(Effect.scoped, Effect.provide(WaitBoard())),
  )
})
