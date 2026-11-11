import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ProfileId, TaskId, Timestamp } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Prompts } from "../agents/Prompts.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { labelOf, parseBackground } from "./background.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import type { RunDir } from "./RunDir.ts"
import { RunEnds } from "./RunEnds.ts"
import { RunInput } from "./RunInput.ts"
import { RunOutput } from "./RunOutput.ts"
import type { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"

// A run's background work on the whole board's services with a scripted agent (huntaway's runner/background.test.ts,
// and the background cases of queue.test.ts and tests.test.ts: HA-187, HA-405). The runs here ask on their output (they
// take input, as every Claude run of this board does), as the old tests' `format: 3` runs did, so a shell that ends by
// itself between turns gets `BACKGROUND_GRACE` for the turn Claude Code takes on it. `background_wait` is 3.5's tool's;
// here the file it writes is written directly.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const Json = Schema.fromJsonString(Schema.Unknown)

type Env =
  | SecureRandom.SecureRandom
  | Runs
  | RunEnds
  | RunOutput
  | RunInput
  | RunRepo
  | RunDir
  | BackgroundWork
  | Prompts
  | TaskRepo
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const running = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
  const n = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))
  const task = TaskId.make(`t-${n}`)
  yield* sql`INSERT INTO tasks (id, profile_id, number, title, status, running, steerable, session_id, last_activity_at, created_at, updated_at)
    VALUES (${task}, ${ProfileId.make("p")}, ${n + 1}, 'A task', 'in_progress', 1, 1, 's1', ${AT}, ${AT}, ${AT})`
  const agent = yield* fakeAgent({ task })
  return { task, agent }
}).pipe(Effect.orDie)

const output = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    for (const line of lines) {
      yield* agent.write([line])
      const end = Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size)
      yield* handler.handle(yield* agent.row, yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie), end)
    }
  })

const shells = (...ids: ReadonlyArray<string>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: `server ${id}` })),
})
const said = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } })
const result = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, session_id: "s1" }
const work = (id: TaskId) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    return (yield* repo.get(id))?.background_work ?? null
  })
const stopTasks = (agent: FakeAgent) =>
  Effect.map(agent.input, (lines) =>
    lines.flatMap((l) => {
      const request: unknown = typeof l === "object" && l !== null && "request" in l ? l.request : null
      return typeof request === "object" &&
        request !== null &&
        "subtype" in request &&
        request.subtype === "stop_task" &&
        typeof l === "object" &&
        l !== null &&
        "request_id" in l
        ? [l]
        : []
    }),
  )

describe("background work", () => {
  it.effect("a turn that leaves only a shell going leaves the task idle; a message goes straight in (HA-187)", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* running
        yield* output(agent, [
          {
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "python3 -m http.server 0", run_in_background: true } }] },
          },
          shells("b1"),
          { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu1", task_type: "local_bash", description: "server b1" },
        ])
        let w = yield* work(task)
        // Working on its turn still.
        assert.strictEqual(w?.idle, false)
        assert.deepStrictEqual(
          w?.tasks.map((t) => [t.id, t.kind, t.description, t.command, t.waited]),
          [["b1", "shell", "server b1", "python3 -m http.server 0", false]],
        )
        yield* output(agent, [result])
        w = yield* work(task)
        assert.deepStrictEqual([w?.idle, w?.run_id], [true, agent.run.id])
        assert.isFalse(yield* agent.inputClosed)
        // A message goes straight in, and the task is working again at once.
        const runs = yield* Runs
        const t = yield* runs.send(task, { text: "is it up?", source: "user" })
        assert.strictEqual(t.queued_message, null)
        yield* (yield* BackgroundWork).sync(agent.run.id)
        assert.strictEqual((yield* work(task))?.idle, false)
        const steer = t.steering[0]?.id ?? ""
        yield* output(agent, [{ type: "user", isReplay: true, uuid: steer, message: { role: "user", content: "is it up?" } }, result])
        assert.strictEqual((yield* work(task))?.idle, true)
        // Once it has ended, nothing is left to show; the run takes its turn on it, or ends after BACKGROUND_GRACE.
        yield* output(agent, [shells()])
        assert.isNull(yield* work(task))
        assert.isFalse(yield* agent.inputClosed)
        yield* TestClock.adjust("120 seconds")
        yield* (yield* RunInput).settled(agent.run.id, "grace")
        assert.isTrue(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("a turn the agent takes on its own shows the task working from its first message; its later ones show nothing anew", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* running
        yield* output(agent, [
          {
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "make watch", run_in_background: true } }] },
          },
          shells("b1"),
          { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu1", task_type: "local_bash", description: "server b1" },
          result,
        ])
        assert.strictEqual((yield* work(task))?.idle, true)
        // Claude Code takes a turn on its own (a shell's outcome, say): its first message finds the run between turns.
        yield* output(agent, [said("The build finished.")])
        assert.isFalse((yield* agent.row).between_turns)
        assert.strictEqual((yield* work(task))?.idle, false)
        // The list changes with no line the banner hears of; the turn's later messages start nothing, so it isn't shown
        // again until the turn ends (the old `turn_started`, which showed it only when the run was between turns).
        const background = yield* BackgroundWork
        yield* background.setTasks(agent.run.id, [
          ...(yield* background.tasks(agent.run.id)),
          { id: "b2", type: "local_bash", description: "server b2", since: AT },
        ])
        yield* output(agent, [said("Starting it again.")])
        assert.deepStrictEqual(
          (yield* work(task))?.tasks.map((t) => t.id),
          ["b1"],
        )
        yield* output(agent, [result])
        const w = yield* work(task)
        assert.deepStrictEqual([w?.idle, w?.tasks.map((t) => t.id)], [true, ["b1", "b2"]])
      }),
    ),
  )

  it.effect("a subagent in the background, or a shell the agent waits on, keeps the task working", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* running
        yield* output(agent, [{ ...shells("b1"), tasks: [{ task_id: "a1", task_type: "local_agent", description: "Explore" }, ...shells("b1").tasks] }, result])
        const w = yield* work(task)
        assert.deepStrictEqual([w?.idle, w?.tasks.map((t) => t.kind)], [false, ["subagent", "shell"]])
        const other = yield* running
        const dir = other.agent.dir
        const fs = yield* FileSystem.FileSystem
        yield* output(other.agent, [shells("b1", "b2")])
        yield* fs.writeFileString(`${dir}/background-waited`, '["b2"]').pipe(Effect.orDie)
        yield* output(other.agent, [result])
        assert.deepStrictEqual([(yield* work(other.task))?.idle, (yield* work(other.task))?.tasks.map((t) => t.waited)], [false, [false, true]])
        // It ended: the dev server left doesn't hold the task.
        yield* output(other.agent, [shells("b1")])
        assert.strictEqual((yield* work(other.task))?.idle, true)
      }),
    ),
  )

  it.effect("files from older builds keep their tasks, of no known type, which hold the task", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        parseBackground('["b1",null]\n').map((t) => t.id),
        ["b1", null],
      )
      assert.strictEqual(parseBackground("2").length, 2)
      assert.deepStrictEqual(parseBackground("nonsense"), [])
      assert.strictEqual(labelOf({ id: "b", type: "local_bash", description: "y".repeat(300), since: null }).length, 160)
    }),
  )

  it.effect("the banner's Stop asks Claude Code to stop the shells; once none is left the run ends, not as a stop", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* running
        const runs = yield* Runs
        yield* output(agent, [shells("b1", "b2"), result])
        assert.deepStrictEqual(yield* runs.stopBackground(task, "b2"), ["b2"])
        const sent = yield* stopTasks(agent)
        assert.deepStrictEqual(
          sent.map((l) => (typeof l === "object" && l !== null && "request" in l ? l.request : null)),
          [{ subtype: "stop_task", task_id: "b2" }],
        )
        const first = sent[0]
        const id = typeof first === "object" && first !== null && "request_id" in first ? first.request_id : ""
        // Claude Code stops it and says so; the other goes on, and so does the run.
        yield* output(agent, [shells("b1"), { type: "control_response", response: { subtype: "success", request_id: id, response: {} } }])
        assert.isFalse(yield* agent.inputClosed)
        assert.strictEqual((yield* agent.row).stop, "none")
        // All of them: they get no turn (Claude Code takes none on a task it was told to stop), so the run ends at once.
        yield* runs.stopBackground(task, null)
        yield* output(agent, [shells()])
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual((yield* agent.row).stop, "none")
        assert.strictEqual((yield* Effect.flip(runs.stopBackground(task, null))).reason, "the agent has no background shells going")
      }),
    ),
  )

  it.effect("a Claude Code that refuses to stop a shell, or doesn't within 10 s, gets the run's stop", () =>
    run(
      Effect.gen(function* () {
        const runs = yield* Runs
        const refused = yield* running
        yield* output(refused.agent, [shells("b1"), result])
        yield* runs.stopBackground(refused.task, null)
        const [asked] = yield* stopTasks(refused.agent)
        const id = typeof asked === "object" && asked !== null && "request_id" in asked ? asked.request_id : ""
        yield* output(refused.agent, [{ type: "control_response", response: { subtype: "error", request_id: id, error: "stop_task is not supported" } }])
        // Between turns kept going only by its shells: killed rather than interrupted.
        assert.strictEqual((yield* refused.agent.row).stop, "requested")
        assert.isTrue(yield* refused.agent.inputClosed)

        const silent = yield* running
        yield* output(silent.agent, [shells("b1"), result])
        yield* runs.stopBackground(silent.task, null)
        yield* TestClock.adjust("10 seconds")
        yield* (yield* RunInput).settled(silent.agent.run.id, "shells")
        assert.strictEqual((yield* silent.agent.row).stop, "requested")
      }),
    ),
  )

  it.effect("what a run's end stopped is noted once in the next prompt, after a command", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* running
        yield* output(agent, [
          {
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "astro   dev\n--port 4331", run_in_background: true } }] },
          },
          { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "Start the dev server" }] },
          { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu1", task_type: "local_bash" },
          result,
        ])
        // The user stops the run, whose stop kills it.
        yield* (yield* Runs).stop(task)
        yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task, exit: { code: null, signal: 15 }, errorTail: "" })
        assert.isNull(yield* work(task))
        const background = yield* BackgroundWork
        const lost = yield* background.takeLost(task)
        assert.deepStrictEqual(lost, [{ kind: "shell", label: "astro dev --port 4331 (Start the dev server)" }])
        const prompts = yield* Prompts
        const command = yield* prompts.start(task, "/code-review high", lost)
        assert.isTrue(command.startsWith("/code-review high\n\nNote: this background work of yours was stopped"), command)
        assert.include(command, "- shell: astro dev --port 4331 (Start the dev server)")
        assert.isTrue((yield* prompts.start(task, "is it up?", lost)).startsWith("Note: this background work"))
        // Once.
        assert.deepStrictEqual(yield* background.takeLost(task), [])
      }),
    ),
  )

  it.effect("a shell that ended during a turn whose outcome the agent wasn't given gets FOLLOW_UP_GRACE; one taken in doesn't", () =>
    run(
      Effect.gen(function* () {
        const { agent } = yield* running
        yield* output(agent, [shells("b1"), shells(), result])
        assert.isFalse(yield* agent.inputClosed)
        yield* TestClock.adjust("15 seconds")
        yield* (yield* RunInput).settled(agent.run.id, "grace")
        assert.isTrue(yield* agent.inputClosed)

        const told = yield* running
        yield* output(told.agent, [
          shells("b2"),
          shells(),
          {
            type: "user",
            isReplay: true,
            uuid: "n1",
            origin: { kind: "task-notification" },
            message: { role: "user", content: "<task-notification><task-id>b2</task-id></task-notification>" },
          },
          result,
        ])
        assert.isTrue(yield* told.agent.inputClosed)
      }),
    ),
  )
})
