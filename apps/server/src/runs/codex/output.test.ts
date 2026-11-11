import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { SqlClient } from "effect/sql"
import { RunId, Timestamp } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Permissions } from "../../permissions/Permissions.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { ThreadReaders } from "../../threads/ThreadReaders.ts"
import { Threads } from "../../threads/Threads.ts"
import type { RunDir } from "../RunDir.ts"
import { RunOutput } from "../RunOutput.ts"
import type { RunRepo } from "../RunRepo.ts"

// A Codex run's line handler (runs/codex/output.ts) on the test board: the follower's `RunOutput` routes a run whose
// folder has `codex.json` to it. What the old agent/codex/driver.test.ts and requests.test.ts checked of the database
// and the run's input: the session and turn written to the task and run, the turn's end closing the input, Codex's
// approvals and questions asked as the thread's prompts and answered on the run's input as Codex takes them (and not
// when Codex stops waiting), the board's tools called as dynamic tools, and a subagent's end ending the wait for it.

const Json = Schema.fromJsonString(Schema.Unknown)

type Env =
  | SecureRandom.SecureRandom
  | RunOutput
  | RunRepo
  | RunDir
  | TaskRepo
  | Threads
  | ThreadReaders
  | Permissions
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** A fake Codex run: its folder says it's Codex's, and its session is `th1`. */
const codexAgent = Effect.gen(function* () {
  const agent = yield* fakeAgent()
  const fs = yield* FileSystem.FileSystem
  yield* fs
    .writeFileString(`${agent.dir}/codex.json`, '{"cwd":"/","approval_policy":"untrusted","approvals_reviewer":"user","sandbox":"read-only"}')
    .pipe(Effect.orDie)
  return agent
})

/** The agent writes `lines`, and the handler takes each in turn, as the follower does. */
const feed = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    let end = (yield* agent.row).out_offset
    for (const line of lines) {
      const text = yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie)
      yield* agent.writeRaw(`${text}\n`)
      end += new TextEncoder().encode(`${text}\n`).length
      yield* handler.handle(yield* agent.row, text, end)
    }
  })

const t = { threadId: "th1" }
const turn = (lines: ReadonlyArray<unknown>, status = "completed") => [
  { method: "turn/started", params: { ...t, turn: { id: "turn1" } } },
  ...lines,
  { method: "turn/completed", params: { ...t, turn: { id: "turn1", status } } },
]
const said = (id: string, text: string) => ({ method: "item/completed", params: { ...t, item: { type: "agentMessage", id, text } } })

describe("a Codex run's output", () => {
  it.effect("its session and turn go on the task and run, its items in the thread, and its turn's end closes the input", () =>
    run(
      Effect.gen(function* () {
        const agent = yield* codexAgent
        yield* feed(agent, [{ method: "thread/started", params: { thread: { id: "th1" } } }, ...turn([said("m1", "Built.")])])
        const task = yield* (yield* TaskRepo).get(agent.run.task_id)
        const row = yield* agent.row
        assert.deepStrictEqual(
          [task?.session_id, row.session_id, row.agent_at, row.saw_result, row.between_turns, row.result_error],
          ["th1", "th1", "turn1", true, true, null],
        )
        const stored = yield* (yield* Threads).stored(agent.run.task_id).pipe(Effect.orDie)
        assert.deepStrictEqual(
          stored.entries.map((e) => e.item.type),
          ["assistant_message", "turn_result"],
        )
        // What the readers say it said last (the old restart case's).
        assert.strictEqual(yield* (yield* ThreadReaders).lastAssistantText(agent.run.task_id), "Built.")
        assert.isTrue(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("a line read again (its offset not saved) adds nothing more", () =>
    run(
      Effect.gen(function* () {
        const agent = yield* codexAgent
        const lines = [{ method: "thread/started", params: { thread: { id: "th1" } } }, said("m1", "Once.")]
        yield* feed(agent, lines)
        yield* feed(agent, [said("m1", "Once.")])
        const stored = yield* (yield* Threads).stored(agent.run.task_id).pipe(Effect.orDie)
        assert.deepStrictEqual(
          stored.entries.map((e) => e.item.id),
          ["m1"],
        )
      }),
    ),
  )

  it.effect("an approval on the output is a prompt, answered on the input as Codex takes it", () =>
    run(
      Effect.gen(function* () {
        const permissions = yield* Permissions
        const agent = yield* codexAgent
        yield* feed(agent, [
          { method: "thread/started", params: { thread: { id: "th1" } } },
          { method: "turn/started", params: { ...t, turn: { id: "turn1" } } },
          { method: "item/started", params: { ...t, item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'make'" } } },
          { id: 10, method: "item/commandExecution/requestApproval", params: { ...t, itemId: "c1", command: "/bin/bash -lc 'make'", cwd: "/w" } },
        ])
        const call = `stdio:${agent.run.id}:codex:10`
        const id = yield* permissions.asking(call)
        const pending = yield* permissions.pending({ task: agent.run.task_id })
        assert.deepStrictEqual(
          pending.map((p) => [p.tool_name, p.input]),
          [["Bash", { command: "make", cwd: "/w" }]],
        )
        yield* permissions.answer(id, { decision: "allow" }, "user")
        yield* permissions.settled(call)
        assert.deepStrictEqual(yield* agent.input, [{ type: "codex_response", id: 10, result: { decision: "accept" } }])
        // The thread's request is for the command's call.
        const stored = yield* (yield* Threads).stored(agent.run.task_id).pipe(Effect.orDie)
        assert.deepStrictEqual(
          stored.requests.map((r) => [r.type, r.tool_call_id, r.resolution?.outcome]),
          [["permission", "c1", "allow"]],
        )
      }),
    ),
  )

  it.effect("Codex's questions are the request_user_input prompt, answered by question id", () =>
    run(
      Effect.gen(function* () {
        const permissions = yield* Permissions
        const agent = yield* codexAgent
        yield* feed(agent, [
          { method: "thread/started", params: { thread: { id: "th1" } } },
          {
            id: "q",
            method: "item/tool/requestUserInput",
            params: {
              ...t,
              itemId: "i1",
              questions: [{ id: "colour", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }],
            },
          },
        ])
        const call = `stdio:${agent.run.id}:codex:"q"`
        const id = yield* permissions.asking(call)
        yield* permissions.answer(id, { decision: "allow", answers: [["Blue"]] }, "user")
        yield* permissions.settled(call)
        assert.deepStrictEqual(yield* agent.input, [{ type: "codex_response", id: "q", result: { answers: { colour: { answers: ["Blue"] } } } }])
      }),
    ),
  )

  it.effect("a request Codex stops waiting for expires its prompt, unanswered", () =>
    run(
      Effect.gen(function* () {
        const permissions = yield* Permissions
        const agent = yield* codexAgent
        yield* feed(agent, [
          { method: "thread/started", params: { thread: { id: "th1" } } },
          { id: 11, method: "item/fileChange/requestApproval", params: { ...t, itemId: "f1" } },
        ])
        const call = `stdio:${agent.run.id}:codex:11`
        yield* permissions.asking(call)
        yield* feed(agent, [{ method: "serverRequest/resolved", params: { ...t, requestId: 11 } }])
        yield* permissions.settled(call)
        assert.deepStrictEqual(yield* permissions.pending({ task: agent.run.task_id }), [])
        assert.deepStrictEqual(yield* agent.input, [])
      }),
    ),
  )

  it.effect("the board's tools are dynamic tools called through its dispatch; another namespace's has no tool", () =>
    run(
      Effect.gen(function* () {
        const agent = yield* codexAgent
        yield* feed(agent, [
          { method: "thread/started", params: { thread: { id: "th1" } } },
          { id: 12, method: "item/tool/call", params: { ...t, callId: "d0", namespace: "other", tool: "x", arguments: {} } },
        ])
        assert.deepStrictEqual(yield* agent.input, [
          { type: "codex_response", id: 12, result: { contentItems: [{ type: "inputText", text: "There's no tool other.x." }], success: false } },
        ])
      }),
    ),
  )

  it.effect("a subagent that ends ends the wait for it", () =>
    run(
      Effect.gen(function* () {
        const agent = yield* codexAgent
        const tasks = yield* TaskRepo
        const at = Timestamp.make("2026-11-12T00:00:00.000Z")
        yield* feed(agent, [
          { method: "thread/started", params: { thread: { id: "th1" } } },
          { method: "thread/started", params: { thread: { id: "child", parentThreadId: "th1", preview: "Look into it" } } },
        ])
        yield* tasks.write(
          agent.run.task_id,
          { agent_wait: { reason: null, since: at, until: at, tasks: [], call_id: "w1", run_id: RunId.make(agent.run.id) } },
          at,
        )
        yield* feed(agent, [{ method: "turn/completed", params: { threadId: "child", turn: { id: "ct", status: "failed", error: { message: "It broke" } } } }])
        const wait = (yield* tasks.get(agent.run.task_id))?.agent_wait
        assert.deepStrictEqual(Option.fromNullishOr(wait?.subagent_finished).pipe(Option.getOrNull), {
          status: "failed",
          summary: "It broke",
          task_id: null,
          tool_use_id: "codex-agent-child",
        })
      }),
    ),
  )
})
