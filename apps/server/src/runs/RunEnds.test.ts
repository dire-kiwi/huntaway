import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ProfileId, ProjectId, TaskId, Timestamp } from "@huntaway/contracts"
import type { Item, Task } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeAgentOptions } from "@huntaway/testing"
import { Reactor } from "../lifecycle/Reactor.ts"
import type { RunExitStatus } from "../platform/Changes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import type { RunDir } from "./RunDir.ts"
import { RunEnds } from "./RunEnds.ts"
import { RunInput } from "./RunInput.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"

// The end of a run and re-attaching after a restart, on the whole board's services with a scripted agent: the cases of
// huntaway's runner/queue.test.ts, tests.test.ts and launch.test.ts that are plan task 2.6's. The end is called as
// the reactor calls it (`RunEnds.ended`), and a "restart" is `Runs.reattach` on the same board, as the old tests'
// `restart()` was `load_active` on the same state. Left out: the merge lane and its approvals (M4), workflows and
// reviews taking a task on (5.x, 6.6), a plan's checkpoints (M4), routines' reports (6.5), background tasks (2.8),
// prompts expiring (3.3, through `AgentRequests.ended`), races the old tests staged with `testing.when` between steps
// that are now one transaction.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const Json = Schema.fromJsonString(Schema.Unknown)
const OK: RunExitStatus = { code: 0, signal: null }

type Env =
  | SecureRandom.SecureRandom
  | Runs
  | RunEnds
  | Reactor
  | RunOutput
  | RunInput
  | RunRepo
  | RunDir
  | TaskRepo
  | Threads
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** A task of profile "p", with its columns as given. */
const newTask = (
  columns: { readonly project?: ProjectId; readonly status?: string; readonly running?: boolean; readonly session?: string; readonly type?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    const n = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))
    const id = TaskId.make(`t-${n}`)
    yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, running, steerable, session_id, task_type, last_activity_at, created_at, updated_at)
      VALUES (${id}, ${ProfileId.make("p")}, ${columns.project ?? null}, ${n + 1}, 'A task', ${columns.status ?? "in_progress"}, ${columns.running === false ? 0 : 1},
        1, ${columns.session ?? "s1"}, ${columns.type ?? null}, ${AT}, ${AT}, ${AT})`
    return id
  }).pipe(Effect.orDie)

const project = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
  yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
    VALUES ('pr', 'p', 'Web', 'WEB', '/tmp/x', '/tmp/x/s', '/tmp/x/w', ${AT})`
  return ProjectId.make("pr")
}).pipe(Effect.orDie)

const running = (options: FakeAgentOptions = {}) =>
  Effect.gen(function* () {
    const task = options.task ?? (yield* newTask())
    const agent = yield* fakeAgent({ ...options, task })
    return { task, agent }
  })

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

/** The agent's run ended (its exit, as the follower tells it). */
const ended = (agent: FakeAgent, exit: RunExitStatus = OK) =>
  Effect.gen(function* () {
    const ends = yield* RunEnds
    yield* ends.ended({ _tag: "RunExited", run: agent.run.id, task: agent.run.task_id, exit, errorTail: "" })
  })

const task = (id: TaskId) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const t = yield* repo.get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })
const items = (id: TaskId) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    return (yield* threads.stored(id).pipe(Effect.orDie)).entries.map((e): Item => e.item)
  })
const notices = (id: TaskId) => Effect.map(items(id), (all) => all.flatMap((i) => (i.type === "notice" ? [i.text] : [])))
const column = (t: Task) => [t.running, t.status, t.attention_reason]
const result = (subtype: string, more: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  total_cost_usd: 0,
  num_turns: 1,
  session_id: "s1",
  ...more,
})

describe("the end of a run", () => {
  it.effect("an ended run's task goes to its column: review, stopped, failed, a question", () =>
    run(
      Effect.gen(function* () {
        const ok = yield* running()
        yield* output(ok.agent, [result("success")])
        yield* ended(ok.agent)
        assert.deepStrictEqual(column(yield* task(ok.task)), [false, "in_review", null])
        assert.strictEqual((yield* ok.agent.row).phase, "exited")

        const stopped = yield* running()
        yield* (yield* Runs).stop(stopped.task)
        yield* output(stopped.agent, [result("error_during_execution")])
        yield* ended(stopped.agent)
        assert.deepStrictEqual(column(yield* task(stopped.task)), [false, "needs_attention", "Stopped by user"])
        assert.deepStrictEqual(yield* notices(stopped.task), ["Run stopped"])

        const failed = yield* running()
        yield* ended(failed.agent, { code: 1, signal: null })
        assert.deepStrictEqual(column(yield* task(failed.task)), [false, "needs_attention", "Run failed: the agent exited with code 1"])

        const asked = yield* running()
        const repo = yield* RunRepo
        yield* repo.update(asked.agent.run.id, { attention: "Which one?" })
        yield* output(asked.agent, [result("success")])
        yield* ended(asked.agent)
        assert.deepStrictEqual(column(yield* task(asked.task)), [false, "needs_attention", "Which one?"])
        // Ended twice (a restart read its exit again): left as it is.
        yield* ended(asked.agent)
        assert.deepStrictEqual(yield* notices(asked.task), [])
      }),
    ),
  )

  it.effect("the assistant waits for the next message; a compaction leaves the card where it was", () =>
    run(
      Effect.gen(function* () {
        const assistant = yield* running({ task: yield* newTask({ type: "assistant" }) })
        yield* output(assistant.agent, [result("success")])
        yield* ended(assistant.agent)
        assert.strictEqual((yield* task(assistant.task)).status, "todo")
        const compacted = yield* running({ task: yield* newTask({ status: "in_review" }), kind: "compact", input: false })
        yield* ended(compacted.agent, { code: 1, signal: null })
        assert.deepStrictEqual(column(yield* task(compacted.task)), [false, "in_review", null])
        assert.deepStrictEqual(yield* notices(compacted.task), ["Compacting failed"])
      }),
    ),
  )

  it.effect("messages the agent never took in go to the next run, ahead of what was queued since", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const runs = yield* Runs
        yield* runs.send(id, { text: "first", source: "user" })
        yield* runs.send(id, { text: "second", source: "agent" })
        // Closed meanwhile (the agent exited), so this one is queued behind them.
        yield* (yield* RunInput).closeInput(agent.run.id)
        yield* runs.send(id, { text: "third", source: "user" })
        const repo = yield* TaskRepo
        // Out of usage, what is queued stays queued for when the limit resets: here, so as to see the queue.
        yield* repo.write(id, { limit_reset_at: Timestamp.make("2999-01-01T00:00:00.000Z") }, AT)
        yield* ended(agent, { code: 1, signal: null })
        const t = yield* task(id)
        assert.deepStrictEqual([t.steering, t.queued_message], [[], "first\n\nsecond\n\nthird"])
        assert.deepStrictEqual(
          (yield* repo.queued(id)).map((q) => q.source),
          ["user", "agent", "user"],
        )
      }),
    ),
  )

  it.effect("a message queued during a run is sent as it ends: the task goes on running, not to its column", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running({ input: false })
        yield* (yield* Runs).send(id, { text: "and then this", source: "user" })
        yield* output(agent, [result("success")])
        yield* ended(agent)
        const t = yield* task(id)
        assert.deepStrictEqual([t.running, t.status, t.queued_message], [true, "in_progress", null])
        const latest = yield* (yield* RunRepo).latest(id)
        assert.isTrue(Option.isSome(latest) && latest.value.id !== agent.run.id && latest.value.phase !== "exited")
      }),
    ),
  )

  it.effect("a message queued during a run waits for dependencies the task gained meanwhile", () =>
    run(
      Effect.gen(function* () {
        const pr = yield* project
        const dependency = yield* newTask({ project: pr, status: "todo", running: false })
        const { task: id, agent } = yield* running({ task: yield* newTask({ project: pr }), input: false })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE tasks SET depends_on = ${`["${dependency}"]`} WHERE id = ${id}`.pipe(Effect.orDie)
        yield* (yield* Runs).send(id, { text: "and then this", source: "user" })
        yield* ended(agent)
        const t = yield* task(id)
        assert.deepStrictEqual([t.running, t.waiting, t.status, t.queued_message], [false, true, "in_progress", "and then this"])
        assert.isFalse(yield* (yield* Runs).isRunning(id))
      }),
    ),
  )

  it.effect("a run that ends after a later one started leaves the task's column to that one", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const later = yield* fakeAgent({ task: id })
        yield* ended(agent, { code: 1, signal: null })
        const t = yield* task(id)
        assert.deepStrictEqual(column(t), [true, "in_progress", null])
        yield* output(later, [result("success")])
        yield* ended(later)
        assert.deepStrictEqual(column(yield* task(id)), [false, "in_review", null])
      }),
    ),
  )

  it.effect("an unfinished todo list keeps the task in progress and asks its agent once; then it needs attention", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const repo = yield* TaskRepo
        const todos = [
          { text: "one", status: "completed" },
          { text: "two", status: "pending" },
        ] as const
        yield* repo.write(id, { todos }, AT)
        yield* output(agent, [result("success")])
        yield* ended(agent)
        const t = yield* task(id)
        // Asked: a message from the board starts a run.
        assert.deepStrictEqual([t.running, t.status], [true, "in_progress"])
        const asked = (yield* items(id)).filter((i) => i.type === "user_message")
        assert.isTrue(asked.at(-1)?.type === "user_message" && asked.at(-1)?.text.startsWith("Your todo list still has unfinished items") === true)
        // That run ends with the list still unfinished: it needs attention.
        const latest = Option.getOrThrow(yield* (yield* RunRepo).latest(id))
        yield* (yield* Runs).launched(id)
        yield* (yield* RunEnds).ended({ _tag: "RunExited", run: latest.id, task: id, exit: OK, errorTail: "" })
        // Its launch had no ia-shim, so it failed: Needs attention for that, which outranks the list.
        assert.strictEqual((yield* task(id)).status, "needs_attention")
      }),
    ),
  )
})

describe("after a restart", () => {
  it.effect("a turn that ended with nothing waiting ends the run; messages waiting still have STEER_GRACE", () =>
    run(
      Effect.gen(function* () {
        const runs = yield* Runs
        const repo = yield* RunRepo
        const quiet = yield* running()
        yield* repo.update(quiet.agent.run.id, { saw_result: true, between_turns: true })
        const waiting = yield* running()
        yield* runs.send(waiting.task, { text: "one more thing", source: "user" })
        yield* repo.update(waiting.agent.run.id, { saw_result: true, between_turns: true })
        // Sent as the turn ended, and kept, before the server stopped, to be written to its input.
        const sql = yield* SqlClient.SqlClient
        const unsent = yield* running()
        yield* sql`INSERT INTO task_steers (id, seq, task_id, run_id, text, source, written, created_at)
          VALUES ('s1', 1, ${unsent.task}, ${unsent.agent.run.id}, 'not sent yet', 'user', 0, ${AT})`.pipe(Effect.orDie)
        yield* repo.update(unsent.agent.run.id, { saw_result: true, between_turns: true })
        yield* runs.reattach
        assert.isTrue(yield* quiet.agent.inputClosed)
        assert.isFalse(yield* waiting.agent.inputClosed)
        const sent = yield* unsent.agent.input
        assert.deepStrictEqual(sent.at(-1), { type: "user", uuid: "s1", message: { role: "user", content: "not sent yet" } })
        assert.isTrue((yield* task(unsent.task)).steering[0]?.written ?? false)
        yield* TestClock.adjust("30 seconds")
        const input = yield* RunInput
        yield* input.settled(waiting.agent.run.id, "steer")
        yield* input.settled(unsent.agent.run.id, "steer")
        assert.isTrue(yield* waiting.agent.inputClosed)
        assert.isTrue(yield* unsent.agent.inputClosed)
        yield* (yield* Runs).stop(quiet.task)
      }),
    ),
  )

  it.effect("a run mid-turn can still take a message at its next step; one an older build started takes none", () =>
    run(
      Effect.gen(function* () {
        const runs = yield* Runs
        const busy = yield* running()
        yield* runs.send(busy.task, { text: "when you get to it", source: "user" })
        const older = yield* running({ input: false })
        yield* runs.reattach
        yield* TestClock.adjust("60 seconds")
        assert.isFalse(yield* busy.agent.inputClosed)
        assert.isFalse((yield* task(older.task)).steerable)
        assert.isTrue((yield* task(busy.task)).steerable)
      }),
    ),
  )

  it.effect("a run that never started, and one from a newer build, end; a task running with no run needs attention", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* RunRepo
        // ia-shim was launched as the server stopped, and hadn't written its output.
        const early = yield* running()
        yield* repo.setPhase(early.agent.run.id, "preparing")
        yield* fs.remove(`${early.agent.dir}/out.jsonl`).pipe(Effect.orDie)
        yield* fs.writeFileString(`${early.agent.dir}/spec.json`, "{}").pipe(Effect.orDie)
        const newer = yield* running()
        yield* fs.writeFileString(`${newer.agent.dir}/run.json`, '{"format": 99}').pipe(Effect.orDie)
        const orphan = yield* newTask()
        yield* (yield* Runs).reattach
        yield* (yield* Reactor).idle
        assert.deepStrictEqual(column(yield* task(early.task)), [
          false,
          "needs_attention",
          "Run failed: Interrupted by a server restart before the agent started",
        ])
        assert.isTrue(yield* early.agent.inputClosed)
        assert.deepStrictEqual(column(yield* task(newer.task)), [
          false,
          "needs_attention",
          "Run failed: This run was started by a newer huntaway; update this host to follow it",
        ])
        assert.deepStrictEqual(column(yield* task(orphan)), [false, "needs_attention", "Interrupted by server restart"])
        assert.deepStrictEqual(yield* notices(orphan), ["Run interrupted by server restart"])
        assert.strictEqual((yield* early.agent.row).phase, "exited")
      }),
    ),
  )

  it.effect("a task whose dependencies are merged starts; one in an archived project waits on", () =>
    run(
      Effect.gen(function* () {
        const pr = yield* project
        const sql = yield* SqlClient.SqlClient
        const dependency = yield* newTask({ project: pr, status: "done", running: false })
        const waiting = yield* newTask({ project: pr, running: false, session: "s1" })
        yield* sql`UPDATE tasks SET depends_on = ${`["${dependency}"]`}, waiting = 1 WHERE id = ${waiting}`.pipe(Effect.orDie)
        yield* (yield* Runs).startUnblocked(pr)
        const t = yield* task(waiting)
        assert.deepStrictEqual([t.waiting, t.running], [false, true])
        assert.include(yield* notices(waiting), "Nothing it depends on is left to merge, so its agent is starting")
        const said = (yield* items(waiting)).flatMap((i) => (i.type === "user_message" ? [i.text] : []))
        assert.deepStrictEqual(said, ["The tasks this one was waiting for are merged (or no longer needed), so carry on with it."])
      }),
    ),
  )
})
