import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { CallId, ProfileId, RunId, Timestamp } from "@huntaway/contracts"
import { BLOCKED } from "@huntaway/shared"
import { fakeAgent, TestMcp, TestMcpOver, TestTools } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { Identity } from "../platform/Identity.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { McpHooks } from "./McpHooks.ts"
import { ToolError } from "./tool.ts"
import type { ToolResult } from "./tool.ts"
import { PRUNE_BATCH, RUN_ENDED, ToolCalls } from "./ToolCalls.ts"

// The dispatcher (docs/plan/07-agents.md, Dispatch) with the test tools on the whole board's services: the old
// mcp/tools/dispatch.test.ts's cases for at most once, a call cut short, a call that can't be recorded, the argument
// check and the gates (reviewers, plan mode, an ended run, the user's rules), and agent/runs.ts's pruning of calls.

const call = (agent: FakeAgent, id: string, tool: string, args: unknown) =>
  Effect.flatMap(ToolCalls, (calls) => calls.call({ call_id: CallId.make(id), run: agent.run.id, server: "huntaway", tool, args }))

const ok = (result: ToolResult) => (result._tag === "Ok" ? result.value : assert.fail(`it failed: ${result.message}`))
const err = (result: ToolResult) => (result._tag === "Err" ? result.message : assert.fail("it didn't fail"))

/** What `test_echo` said back. */
const Echoed = Schema.Struct({ text: Schema.String, task: Schema.String, profile: Schema.String, mode: Schema.String })
const echoed = (result: ToolResult) => {
  const value = ok(result)
  return Schema.is(Echoed)(value) ? value : assert.fail("not what test_echo says")
}

const touched = Effect.flatMap(TestTools, (tools) => tools.touched)

const exec = (statement: string, ...params: ReadonlyArray<string | number | null>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement, params)).pipe(Effect.orDie)

interface CallRow {
  readonly status: string
  readonly result: string | null
  readonly error: string | null
  readonly task_id: string
}

const callRow = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql<CallRow>`SELECT status, result, error, task_id FROM mcp_calls WHERE id = ${id}`).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  )

/** The hooks, recorded in `seen`: the calls that ended a wait, the asks (allowed unless `deny`), the cancelled calls. */
const recordingHooks = (seen: Ref.Ref<ReadonlyArray<string>>, deny = false) =>
  Layer.succeed(
    McpHooks,
    McpHooks.of({
      callMade: (caller) => Ref.update(seen, (all) => [...all, `made:${caller.call_id}`]),
      askRule: (caller, name) =>
        Ref.update(seen, (all) => [...all, `ask:${caller.call_id}:${name}`]).pipe(
          Effect.andThen(deny ? Effect.fail(ToolError.other("The user denied this action.")) : Effect.void),
        ),
      cancelled: (_run, id) => Ref.update(seen, (all) => [...all, `cancelled:${id}`]),
    }),
  )

/** Runs `body` with the test tools and hooks that record what they are asked into `seen`. */
const withHooks = <A, E, R>(body: (seen: Ref.Ref<ReadonlyArray<string>>) => Effect.Effect<A, E, R>, deny = false) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    return yield* body(seen).pipe(Effect.provide(TestMcp(recordingHooks(seen, deny))))
  })

describe("ToolCalls", () => {
  it.effect("a call runs once, is recorded done with its result, and a later delivery gets that result", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      assert.deepStrictEqual(ok(yield* call(agent, "c1", "test_touch", { label: "once" })), { count: 1 })
      const row = yield* callRow("c1")
      assert.deepStrictEqual([row?.status, row?.result, row?.error, row?.task_id], ["done", '{"count":1}', null, agent.run.task_id])
      assert.deepStrictEqual(ok(yield* call(agent, "c1", "test_touch", { label: "once" })), { count: 1 })
      assert.deepStrictEqual(yield* touched, ["once"])
      // An error is recorded as one too, and given again.
      assert.include(err(yield* call(agent, "c2", "test_touch", {})), "test_touch needs label")
      assert.include(err(yield* call(agent, "c2", "test_touch", { label: "now right" })), "test_touch needs label")
      assert.deepStrictEqual(yield* touched, ["once"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("two deliveries of a call racing run it once, and both get its result", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const calls = yield* ToolCalls
      const agent = yield* fakeAgent()
      const first = yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
      yield* tools.blocked("k")
      const second = yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
      assert.isTrue(yield* calls.isRunning(CallId.make("c1")))
      assert.strictEqual((yield* callRow("c1"))?.status, "executing")
      yield* tools.release("k")
      assert.deepStrictEqual(ok(yield* Fiber.join(first)), { key: "k" })
      assert.deepStrictEqual(ok(yield* Fiber.join(second)), { key: "k" })
      assert.deepStrictEqual(yield* touched, ["block:k"])
      assert.isFalse(yield* calls.isRunning(CallId.make("c1")))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a client that goes away doesn't stop its call", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const agent = yield* fakeAgent()
      const gone = yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
      yield* tools.blocked("k")
      yield* Fiber.interrupt(gone)
      const again = yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
      yield* tools.release("k")
      assert.deepStrictEqual(ok(yield* Fiber.join(again)), { key: "k" })
      assert.deepStrictEqual(yield* touched, ["block:k"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a call cut short by a restart doesn't run again, unless it can safely", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const agent = yield* fakeAgent()
      // The server goes down after the call did what it does, before it recorded that it had.
      yield* Effect.gen(function* () {
        yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
        yield* Effect.forkChild(call(agent, "w1", "wait", { key: "w" }))
        yield* tools.blocked("k")
        yield* tools.blocked("w")
      }).pipe(Effect.provide(TestMcpOver()))
      assert.deepStrictEqual([(yield* callRow("c1"))?.status, (yield* callRow("w1"))?.status], ["executing", "executing"])
      // The agent retries the calls with their ids once the server is back.
      yield* Effect.gen(function* () {
        const e = err(yield* call(agent, "c1", "test_block", { key: "k" }))
        assert.isTrue(e.startsWith("This test_block call was interrupted (the board's server restarted while it ran), so it isn't run again"), e)
        assert.include(e, "may or may not have taken effect")
        assert.deepStrictEqual(yield* touched, ["block:k"])
        assert.strictEqual((yield* callRow("c1"))?.status, "done")
        // `wait` picks up where it was.
        yield* tools.release("w")
        assert.deepStrictEqual(ok(yield* call(agent, "w1", "wait", { key: "w" })), { key: "w" })
      }).pipe(Effect.provide(TestMcpOver()))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a call cut short while an approval rule's prompt was pending runs again: it changed nothing", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const agent = yield* fakeAgent()
      yield* Effect.gen(function* () {
        yield* Effect.forkChild(call(agent, "c1", "test_block", { key: "k" }))
        yield* tools.blocked("k")
      }).pipe(Effect.provide(TestMcpOver()))
      yield* exec(
        `INSERT INTO permission_requests (id, task_id, write_no, tool_name, input, status, kind, call_id, rule, created_at)
         VALUES ('r1', ?, 0, 'mcp__huntaway__test_block', '{}', 'pending', 'tool', 'c1', 'mcp__huntaway', '2026-11-12T00:00:00.000Z')`,
        agent.run.task_id,
      )
      yield* Effect.gen(function* () {
        yield* tools.release("k")
        assert.deepStrictEqual(ok(yield* call(agent, "c1", "test_block", { key: "k" })), { key: "k" })
      }).pipe(Effect.provide(TestMcpOver()))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a call the board can't record isn't run", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      // Recording it fails (a full disk, say), twice.
      yield* exec("CREATE TRIGGER no_calls BEFORE INSERT ON mcp_calls BEGIN SELECT RAISE(ABORT, 'disk full'); END")
      for (const _ of [1, 2]) {
        const e = err(yield* call(agent, "c1", "test_touch", { label: "child" }))
        assert.isTrue(e.startsWith("The board couldn't record this test_touch call, so it wasn't run (call it again)") && e.includes("disk full"), e)
      }
      assert.deepStrictEqual(yield* touched, [])
      // So does finding out whether it ran.
      yield* exec("DROP TRIGGER no_calls")
      yield* exec("ALTER TABLE mcp_calls RENAME TO calls")
      assert.include(err(yield* call(agent, "c1", "test_touch", { label: "child" })), "couldn't record")
      assert.deepStrictEqual(yield* touched, [])
      yield* exec("ALTER TABLE calls RENAME TO mcp_calls")
      ok(yield* call(agent, "c1", "test_touch", { label: "child" }))
      assert.deepStrictEqual(yield* touched, ["child"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a guessed argument name says what the tool takes", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      const hint = "If you haven't loaded this tool's schema (e.g. with ToolSearch), load it first."
      // An agent that never loaded the schema guessed `txt` and would have got the default.
      assert.strictEqual(err(yield* call(agent, "c1", "test_echo", { txt: "a" })), `test_echo has no argument "txt"; its arguments are n, text. ${hint}`)
      assert.strictEqual(err(yield* call(agent, "c2", "test_echo", {})), `test_echo needs text (its arguments are n, text). ${hint}`)
      assert.strictEqual(err(yield* call(agent, "c3", "test_echo", { text: "" })), `test_echo needs text (its arguments are n, text). ${hint}`)
      assert.strictEqual(err(yield* call(agent, "c4", "test_echo", null)), `test_echo needs text (its arguments are n, text). ${hint}`)
      assert.strictEqual(err(yield* call(agent, "c5", "test_echo", ["a"])), "test_echo's arguments must be an object")
      assert.include(err(yield* call(agent, "c6", "test_echo", { text: 5 })), "test_echo's arguments don't fit its schema")
      // `host` picks a linked host, whatever the tool: this host's own name is here, and one it doesn't link is refused.
      const { hostName } = yield* Identity
      assert.deepStrictEqual(ok(yield* call(agent, "c7", "test_echo", { text: "a", host: hostName.toUpperCase() })), {
        text: "a",
        task: agent.run.task_id,
        profile: "p",
        mode: "default",
      })
      assert.strictEqual(err(yield* call(agent, "c7b", "test_echo", { text: "a", host: "elsewhere" })), "no linked host named elsewhere")
      assert.strictEqual(err(yield* call(agent, "c8", "no_such_tool", {})), "unknown tool no_such_tool")
      // A tool that dies is an error for the agent, recorded as the call's answer.
      assert.include(err(yield* call(agent, "c9", "test_echo", { text: "die" })), "The board failed running test_echo")
      assert.strictEqual((yield* callRow("c9"))?.status, "done")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a run the board has ended gets nothing done, nor does one it never had", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      // Its shim vanished and the board ended it, but its agent still calls.
      yield* (yield* RunRepo).end(agent.run.id, Timestamp.make("2026-11-12T01:00:00.000Z"))
      for (const [id, tool, args] of [
        ["c1", "test_touch", { label: "x" }],
        ["c2", "test_echo", { text: "x" }],
        ["c3", "no_such_tool", {}],
      ] as const) {
        assert.strictEqual(err(yield* call(agent, id, tool, args)), RUN_ENDED(tool))
      }
      assert.deepStrictEqual(yield* touched, [])
      const calls = yield* ToolCalls
      const unknown = yield* calls.call({
        call_id: CallId.make("c4"),
        run: RunId.make("no-such-run"),
        server: "huntaway",
        tool: "test_echo",
        args: { text: "x" },
      })
      assert.strictEqual(err(unknown), "unknown run")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a reviewer can only call the reviewers' tools, whatever its tool list offers", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      yield* exec("UPDATE tasks SET kind = 'review' WHERE id = ?", agent.run.task_id)
      assert.strictEqual(
        err(yield* call(agent, "c1", "test_touch", { label: "x" })),
        "test_touch isn't available to reviewers: they can only read the board and submit_review",
      )
      assert.deepStrictEqual(yield* touched, [])
      assert.strictEqual(echoed(yield* call(agent, "c2", "test_echo", { text: "read" })).text, "read")
      ok(yield* call(agent, "c3", "submit_test_review", {}))
      // A task's own agent keeps them all, but not the reviewers' own.
      const own = yield* fakeAgent()
      ok(yield* call(own, "c4", "test_touch", { label: "own" }))
      assert.deepStrictEqual(yield* touched, ["own"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a thread in plan mode only calls the planning tools, by its mode at the call", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      const refused =
        "test_touch isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only read the board, wait and request_user_input"
      yield* exec("UPDATE tasks SET permission_mode = 'plan' WHERE id = ?", agent.run.task_id)
      assert.strictEqual(err(yield* call(agent, "c1", "test_touch", { label: "x" })), refused)
      assert.strictEqual(echoed(yield* call(agent, "c2", "test_echo", { text: "read" })).mode, "plan")
      // Its plan approved, it carries on in another mode with them all.
      yield* exec("UPDATE tasks SET permission_mode = NULL WHERE id = ?", agent.run.task_id)
      ok(yield* call(agent, "c3", "test_touch", { label: "after" }))
      // As does a thread that inherits plan mode from its project, or from the host's default.
      yield* exec(
        `INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, permission_mode, created_at)
         VALUES ('proj', 'p', 'Proj', 'PRO', '/tmp/x', '/tmp/s', '/tmp/w', 'plan', '2026-11-12T00:00:00.000Z')`,
      )
      yield* exec("UPDATE tasks SET project_id = 'proj' WHERE id = ?", agent.run.task_id)
      assert.strictEqual(err(yield* call(agent, "c4", "test_touch", { label: "x" })), refused)
      yield* exec("UPDATE projects SET permission_mode = NULL")
      yield* exec("INSERT INTO settings (key, value) VALUES ('default_permission_mode', 'plan')")
      assert.strictEqual(err(yield* call(agent, "c5", "test_touch", { label: "x" })), refused)
      assert.deepStrictEqual(yield* touched, ["after"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("any call but wait ends the run's wait", () =>
    withHooks((seen) =>
      Effect.gen(function* () {
        const tools = yield* TestTools
        const agent = yield* fakeAgent()
        ok(yield* call(agent, "c1", "test_echo", { text: "x" }))
        yield* tools.release("w")
        ok(yield* call(agent, "w1", "wait", { key: "w" }))
        // Nor a call refused before it got that far.
        err(yield* call(agent, "c2", "test_echo", {}))
        assert.deepStrictEqual(yield* Ref.get(seen), ["made:c1"])
      }),
    ),
  )

  it.effect("the assistant's rules can refuse a board tool or make it ask first, whatever its mode", () =>
    withHooks((seen) =>
      Effect.gen(function* () {
        const rules = yield* ApprovalRules
        const agent = yield* fakeAgent()
        const profile = ProfileId.make("p")
        yield* exec("UPDATE tasks SET task_type = 'assistant', permission_mode = 'bypassPermissions' WHERE id = ?", agent.run.task_id)
        yield* rules.set(profile, {
          rules: [
            { tool: "mcp__huntaway__test_touch", decision: "never" },
            { tool: "mcp__huntaway__wait", decision: "ask" },
          ],
        })
        // Never: refused without asking, and logged.
        const e = err(yield* call(agent, "c1", "test_touch", { label: "x" }))
        assert.isTrue(e.startsWith(BLOCKED), e)
        assert.deepStrictEqual(yield* touched, [])
        assert.deepStrictEqual(
          (yield* rules.log({ profile_id: profile })).map((a) => [a.tool_name, a.outcome]),
          [["mcp__huntaway__test_touch", "blocked"]],
        )
        // Ask: the user is asked (here, allowed), `wait` included.
        const tools = yield* TestTools
        yield* tools.release("w")
        ok(yield* call(agent, "w1", "wait", { key: "w" }))
        assert.deepStrictEqual(
          (yield* Ref.get(seen)).filter((entry) => entry.startsWith("ask:")),
          ["ask:w1:mcp__huntaway__wait"],
        )
        // Other tools are as they were.
        ok(yield* call(agent, "c2", "test_echo", { text: "x" }))
        // An older name of the board's server holds too.
        yield* rules.set(profile, { rules: [{ tool: "mcp__issue_agent__test_echo", decision: "never" }] })
        assert.isTrue(err(yield* call(agent, "c3", "test_echo", { text: "x" })).startsWith(BLOCKED))
        // Rules hold for the assistant only (and threads under it).
        const other = yield* fakeAgent()
        ok(yield* call(other, "c4", "test_echo", { text: "x" }))
      }),
    ),
  )

  it.effect("an ask the user denies, or that no one can answer yet, refuses the call", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      yield* exec("UPDATE tasks SET task_type = 'assistant' WHERE id = ?", agent.run.task_id)
      yield* (yield* ApprovalRules).set(ProfileId.make("p"), { rules: [{ tool: "mcp__huntaway__test_touch", decision: "ask" }] })
      assert.include(err(yield* call(agent, "c1", "test_touch", { label: "x" })), "can't ask the user yet")
      assert.deepStrictEqual(yield* touched, [])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("calls are pruned an hour after their run ended, a batch at a time", () =>
    Effect.gen(function* () {
      const calls = yield* ToolCalls
      const agent = yield* fakeAgent()
      const ended = yield* fakeAgent()
      // The test clock is at 1970-01-01T00:00:00Z.
      const old = "1969-12-31T22:00:00.000Z"
      yield* (yield* RunRepo).end(ended.run.id, Timestamp.make(old))
      const insert = (id: string, run: string) =>
        exec("INSERT INTO mcp_calls (id, run_id, task_id, tool, args, status, created_at) VALUES (?, ?, '', 'test_echo', '{}', 'done', ?)", id, run, old)
      yield* insert("live", agent.run.id)
      yield* insert("ended", ended.run.id)
      for (let i = 0; i < PRUNE_BATCH + 1; i++) yield* insert(`gone-${i}`, "no-such-run")
      assert.strictEqual(yield* calls.prune, PRUNE_BATCH + 2)
      const left = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly id: string }>`SELECT id FROM mcp_calls`).pipe(Effect.orDie)
      assert.deepStrictEqual(
        left.map((row) => row.id),
        ["live"],
      )
    }).pipe(Effect.provide(TestMcp())),
  )
})
