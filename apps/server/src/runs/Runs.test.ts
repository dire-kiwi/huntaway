import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ProfileId, ProjectId, TaskId, Timestamp } from "@huntaway/contracts"
import type { Item } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeAgentOptions } from "@huntaway/testing"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { RunDir } from "./RunDir.ts"
import { RunInput, STEER_GRACE, STOP_GRACE } from "./RunInput.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"
import type { SendRefused } from "./Runs.ts"
import type { Outgoing } from "./queue.ts"

// Runs and a Claude run's output on the whole board's services, with a scripted agent (`fakeAgent`: a run's row and
// folder, no process) whose output is handed to the line handler as the follower would hand it. The cases of
// huntaway's runner/queue.test.ts, send.test.ts, tests.test.ts and output.test.ts that are this task's (2.4/2.5).
//
// Left to plan task 2.6 (the end of a run, and re-attaching): what `finish` does (requeueing steers never taken in,
// sending what is queued as a run ends, the later-run rule, the column), every "after a restart" case, a newer build's
// run, the archived project's waiting tasks being started (`start_unblocked`), compacting while a dependency merges. To
// 2.8 (background work, tokens, context): every case with background tasks (HA-187), context sizes and compactions'
// statistics. To later areas: the title refreshed from the user's message (Titles), waits ended by a turn (3.5), usage
// limits (Usage), routines' and automations' costs (6.5, 6.4), Codex (M5).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const Json = Schema.fromJsonString(Schema.Unknown)

type Env =
  | SecureRandom.SecureRandom
  | Runs
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

/** A project of profile "p" (made once), archived or not. */
const project = (archived = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at, archived_at)
      VALUES ('pr', 'p', 'Old', 'OLD', '/tmp/x', '/tmp/x/s', '/tmp/x/w', ${AT}, ${archived ? AT : null})`
    return ProjectId.make("pr")
  }).pipe(Effect.orDie)

/** A task of profile "p", in a project or none, with its columns as given. */
const newTask = (columns: { readonly project?: ProjectId; readonly status?: string; readonly running?: boolean; readonly session?: string } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    const n = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))
    const id = TaskId.make(`t-${n}`)
    yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, running, steerable, session_id, last_activity_at, created_at, updated_at)
      VALUES (${id}, ${ProfileId.make("p")}, ${columns.project ?? null}, 1, 'A task', ${columns.status ?? "in_progress"}, ${columns.running === true ? 1 : 0},
        ${columns.running === true ? 1 : 0}, ${columns.session ?? null}, ${AT}, ${AT}, ${AT})`
    return id
  }).pipe(Effect.orDie)

/** A task whose agent is running a run that takes input (or not), with no process behind it. */
const running = (options: FakeAgentOptions = {}) =>
  Effect.gen(function* () {
    const task = options.task ?? (yield* newTask({ running: true, session: "s1" }))
    const agent = yield* fakeAgent({ ...options, task })
    return { task, agent }
  })

/** The agent writes these lines, and the handler applies them as the follower would, each with the offset after it. */
const output = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    const path = `${agent.dir}/out.jsonl`
    for (const line of lines) {
      yield* agent.write([line])
      const end = Number((yield* fs.stat(path).pipe(Effect.orDie)).size)
      const text = typeof line === "string" ? line : yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie)
      yield* handler.handle(yield* agent.row, text, end)
    }
  })

const send = (task: TaskId, text: string, more: Partial<Outgoing> = {}) =>
  Effect.gen(function* () {
    const runs = yield* Runs
    return yield* runs.send(task, { text, source: "user", ...more })
  })
const items = (task: TaskId) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    const stored = yield* threads.stored(task).pipe(Effect.orDie)
    return stored.entries.map((e): Item => e.item)
  })
const userMessages = (task: TaskId) =>
  Effect.map(items(task), (all) => all.flatMap((i) => (i.type === "user_message" ? [{ text: i.text, steered: i.steered === true }] : [])))
const results = (task: TaskId) => Effect.map(items(task), (all) => all.filter((i) => i.type === "turn_result"))
const task = (id: TaskId) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const t = yield* repo.get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })

/** The one element of a list (a test's steer). */
const only = <A>(list: ReadonlyArray<A>): A => {
  const [a] = list
  if (a === undefined || list.length !== 1) throw new Error(`expected one, got ${list.length}`)
  return a
}

/** What an option holds. */
const some = <A>(o: Option.Option<A>): A => Option.getOrThrowWith(o, () => new Error("expected some"))

/** Why a message was refused. */
const refusal = <A, R>(effect: Effect.Effect<A, SendRefused | { readonly _tag: "TaskNotFound" }, R>) =>
  Effect.flip(effect).pipe(Effect.map((e) => (e._tag === "SendRefused" ? e : assert.fail(`expected SendRefused, got ${e._tag}`))))

const replay = (id: string, text: string) => ({ type: "user", isReplay: true, uuid: id, message: { role: "user", content: text } })
const result = (subtype: string, cost: number, more: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  total_cost_usd: cost,
  num_turns: 1,
  session_id: "s1",
  ...more,
})
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })

describe("Runs.send", () => {
  it.effect("steers a message into the running turn; it enters the thread when the agent takes it in", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        let t = yield* send(id, "  also do this  ")
        assert.strictEqual(t.queued_message, null)
        assert.strictEqual(t.steering.length, 1)
        const steer = only(t.steering)
        assert.isTrue(steer.written)
        assert.deepStrictEqual(yield* agent.input, [{ type: "user", uuid: steer.id, message: { role: "user", content: "also do this" } }])
        // Nothing in the thread until the agent takes it in.
        assert.deepStrictEqual(yield* userMessages(id), [])

        yield* output(agent, [replay("the prompt's id", "the prompt"), replay(steer.id, "also do this")])
        assert.deepStrictEqual(yield* userMessages(id), [{ text: "also do this", steered: true }])
        assert.deepStrictEqual((yield* task(id)).steering, [])
        assert.isFalse(yield* agent.inputClosed)

        // Nothing left waiting, so the turn's end ends the run.
        yield* output(agent, [result("success", 0.5)])
        assert.isTrue(yield* agent.inputClosed)
        // A message sent now can't reach this run any more: it waits for the next.
        t = yield* send(id, "too late")
        assert.deepStrictEqual([t.queued_message, t.steering.length], ["too late", 0])
      }),
    ),
  )

  it.effect("a message that misses the turn starts the next; each turn's result shows its own cost", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const steer = only((yield* send(id, "one more thing")).steering)
        // The turn ends before the agent took it in: it starts the next turn instead.
        yield* output(agent, [result("success", 0.1)])
        assert.isFalse(yield* agent.inputClosed)
        yield* output(agent, [replay(steer.id, "one more thing"), result("success", 0.25)])
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual((yield* userMessages(id)).length, 1)
        const costs = (yield* results(id)).map((r) => {
          const metadata: unknown = r.metadata
          return typeof metadata === "object" && metadata !== null && "total_cost_usd" in metadata ? metadata.total_cost_usd : null
        })
        assert.strictEqual(costs.length, 2)
        assert.closeTo(typeof costs[1] === "number" ? costs[1] : 0, 0.15, 1e-9)
        assert.closeTo((yield* task(id)).cost_usd, 0.25, 1e-9)
      }),
    ),
  )

  it.effect("messages waiting at a turn's end get STEER_GRACE to start the next turn, then the input is closed", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        yield* send(id, "one more thing")
        yield* output(agent, [result("success", 0.1)])
        const input = yield* RunInput
        yield* TestClock.adjust("29 seconds")
        assert.isFalse(yield* agent.inputClosed)
        yield* TestClock.adjust("1 second")
        yield* input.settled(agent.run.id, "steer")
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual(STEER_GRACE, "30 seconds")
      }),
    ),
  )

  it.effect("queues for runs that can't take messages: an older build's, and /compact", () =>
    run(
      Effect.gen(function* () {
        {
          const { task: id } = yield* running({ input: false })
          const t = yield* send(id, "later")
          assert.deepStrictEqual([t.queued_message, t.steering.length], ["later", 0])
        }
        const { task: id, agent } = yield* running()
        const t = yield* send(id, "/compact")
        assert.deepStrictEqual([t.queued_message, t.steering.length], ["/compact", 0])
        assert.deepStrictEqual(yield* agent.input, [])
      }),
    ),
  )

  it.effect("messages sent while a run is prepared go once its agent starts", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running({ input: false })
        const repo = yield* RunRepo
        yield* repo.setPhase(agent.run.id, "preparing")
        let t = yield* send(id, "early")
        assert.isFalse(t.steering[0]?.written ?? true)
        // Once the shim is up.
        const dir = yield* RunDir
        yield* dir.createInput(agent.run.id)
        assert.isTrue(yield* (yield* RunInput).writeSteers(id))
        t = yield* task(id)
        assert.isTrue(t.steering[0]?.written ?? false)
        assert.deepStrictEqual(yield* agent.input, [{ type: "user", uuid: t.steering[0]?.id, message: { role: "user", content: "early" } }])
      }),
    ),
  )

  it.effect("/plan gives the task the plan label, and waits for a run that can write the plan", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const t = yield* send(id, "/plan  the cache ")
        assert.deepStrictEqual(t.labels, ["plan"])
        assert.deepStrictEqual([t.queued_message, t.steering.length], ["/plan  the cache", 0])
        assert.deepStrictEqual(yield* agent.input, [])
        // An ordinary message still goes to it; and a command that only starts the same way isn't it.
        assert.strictEqual((yield* send(id, "and this")).steering.length, 1)
        const other = yield* running()
        yield* send(other.task, "/planner go")
        assert.deepStrictEqual(
          (yield* other.agent.input).map((l) => (typeof l === "object" && l !== null && "message" in l ? l.message : null)),
          [{ role: "user", content: "/planner go" }],
        )
        assert.deepStrictEqual((yield* task(other.task)).labels, [])
      }),
    ),
  )

  it.effect("another agent's message leaves the question to the user and finish_work; the user's answers it", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const repo = yield* RunRepo
        yield* repo.update(agent.run.id, { attention: "Which one?", finished: true })
        const fromAgent = only((yield* send(id, "from another task", { source: "agent" })).steering)
        assert.isTrue(fromAgent.from_agent)
        yield* output(agent, [replay(fromAgent.id, "from another task")])
        let row = yield* agent.row
        assert.deepStrictEqual([row.attention, row.finished], ["Which one?", true])
        const mine = only((yield* send(id, "the second")).steering)
        yield* output(agent, [replay(mine.id, "the second")])
        row = yield* agent.row
        assert.deepStrictEqual([row.attention, row.finished], [null, false])
      }),
    ),
  )

  it.effect("an archived project's agents don't start, and its messages aren't queued where nothing would send them", () =>
    run(
      Effect.gen(function* () {
        const pr = yield* project(true)
        const id = yield* newTask({ project: pr, status: "todo" })
        const failed = yield* refusal(send(id, "Go"))
        assert.strictEqual(failed.reason, "archived")
        assert.include(failed.detail, "is archived")
        const t = yield* task(id)
        assert.deepStrictEqual([t.status, t.waiting, t.queued_message, t.running], ["todo", false, null, false])
      }),
    ),
  )

  it.effect("a message to a task waiting for its usage limit's reset joins the queue, and it carries on once the limit resets", () =>
    run(
      Effect.gen(function* () {
        const id = yield* newTask({ status: "in_progress" })
        const sql = yield* SqlClient.SqlClient
        // The test clock starts at 1970: an hour later is ahead of it.
        yield* sql`UPDATE tasks SET waiting = 1, limit_reset_at = '1970-01-01T01:00:00.000Z' WHERE id = ${id}`.pipe(Effect.orDie)
        const t = yield* send(id, "Carry on")
        assert.deepStrictEqual([t.waiting, t.running, t.queued_message, t.limit_reset_at], [true, false, "Carry on", "1970-01-01T01:00:00.000Z"])
        assert.isFalse(yield* (yield* Runs).isRunning(id))
        // A minute after the reset, the next pass starts it with what was queued.
        yield* TestClock.adjust("62 minutes")
        yield* (yield* Runs).startUnblocked(null)
        const after = yield* task(id)
        assert.deepStrictEqual([after.waiting, after.running, after.queued_message, after.limit_reset_at], [false, true, null, null])
        assert.include(
          (yield* items(id)).flatMap((i) => (i.type === "notice" ? [i.text] : [])),
          "Its usage limit has reset, so its agent is carrying on",
        )
      }),
    ),
  )

  it.effect("a message to a task whose dependencies aren't merged waits for them, queued", () =>
    run(
      Effect.gen(function* () {
        const pr = yield* project()
        const dependency = yield* newTask({ project: pr, status: "todo" })
        const id = yield* newTask({ project: pr, status: "todo" })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE tasks SET depends_on = ${`["${dependency}"]`} WHERE id = ${id}`.pipe(Effect.orDie)
        const t = yield* send(id, "Do the thing")
        assert.deepStrictEqual([t.waiting, t.status, t.queued_message, t.running], [true, "in_progress", "Do the thing", false])
        const notices = (yield* items(id)).flatMap((i) => (i.type === "notice" ? [i.text] : []))
        assert.deepStrictEqual(notices, ["Queued until OLD-1 is merged"])
        assert.isFalse(yield* (yield* Runs).isRunning(id))
      }),
    ),
  )

  it.effect("a queued message stays when its run can't start: no agents on this host, or its registration fails", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const id = yield* newTask({ status: "todo" })
        const repo = yield* TaskRepo
        yield* repo.enqueue(id, { text: "First", source: "agent", automation_run_id: null }, AT)
        const failed = yield* refusal(send(id, "Second"))
        assert.strictEqual(failed.reason, "no_agents")
        assert.deepStrictEqual(yield* repo.queued(id), [{ text: "First", source: "agent", automation_run_id: null }])
      }).pipe(Effect.scoped, Effect.provide(TestBoard({ noAgents: true })))
      yield* run(
        Effect.gen(function* () {
          const id = yield* newTask({ status: "todo" })
          const repo = yield* TaskRepo
          const sql = yield* SqlClient.SqlClient
          yield* repo.enqueue(id, { text: "queued", source: "user", automation_run_id: null }, AT)
          // The task can't be marked running (the disk is full, say).
          yield* sql`CREATE TRIGGER no_start BEFORE UPDATE OF running ON tasks WHEN NEW.running = 1 BEGIN SELECT RAISE(ABORT, 'disk full'); END`.pipe(
            Effect.orDie,
          )
          const exit = yield* Effect.exit(send(id, "go"))
          assert.isTrue(Exit.isFailure(exit))
          const runs = yield* Runs
          assert.isFalse(yield* runs.isRunning(id))
          const t = yield* task(id)
          assert.deepStrictEqual([t.running, t.queued_message], [false, "queued"])
          assert.deepStrictEqual(yield* userMessages(id), [])
        }),
      )
    }),
  )

  it.effect("takes back what is queued, giving the task as it was", () =>
    run(
      Effect.gen(function* () {
        const { task: id } = yield* running({ input: false })
        yield* send(id, "later")
        const runs = yield* Runs
        const was = yield* runs.dropQueued(id)
        assert.strictEqual(was.queued_message, "later")
        assert.strictEqual((yield* task(id)).queued_message, null)
      }),
    ),
  )

  it.effect("/new starts a new conversation, refused while the agent runs", () =>
    run(
      Effect.gen(function* () {
        const { task: id } = yield* running()
        const failed = yield* refusal(send(id, "/new"))
        assert.strictEqual(failed.reason, "agent_running")
        const idle = yield* newTask({ status: "in_review", session: "s9" })
        const t = yield* send(idle, "/new")
        assert.deepStrictEqual([t.session_id, t.running], [null, false])
        const notices = (yield* items(idle)).flatMap((i) => (i.type === "notice" ? [i.text] : []))
        assert.deepStrictEqual(notices, ["The next message starts a new conversation with the agent"])
      }),
    ),
  )
})

describe("starting a run", () => {
  it.effect("registers the run with its message, the task running, and launches it: a launch that fails leaves no agent behind", () =>
    run(
      Effect.gen(function* () {
        const runs = yield* Runs
        const repo = yield* RunRepo
        const dir = yield* RunDir
        const id = yield* newTask({ status: "todo" })
        const t = yield* send(id, "hello")
        assert.deepStrictEqual([t.running, t.steerable, t.status, t.run_started_at !== null], [true, true, "in_progress", true])
        assert.deepStrictEqual(yield* userMessages(id), [{ text: "hello", steered: false }])
        const started = { value: some(yield* repo.latest(id)) }
        assert.strictEqual(started.value.kind, "prompt")
        assert.isNotNull(started.value.write_no)
        // This test server has no ia-shim: the launch writes the run's folder, then gives up, and reaps it.
        yield* runs.launched(id)
        const spec = yield* dir.spec(started.value.id)
        assert.isTrue(spec !== null && spec.args.includes("--input-format") && spec.args.at(-2) === "--mcp-config")
        // Its temp folder (its TMPDIR) is one it may read and write.
        const tmp = spec?.args.findLast((a, i) => spec.args[i - 1] === "--add-dir")
        assert.isTrue(tmp !== undefined && tmp.includes("task-tmp"), tmp)
        assert.isTrue(yield* dir.inputClosed(started.value.id))
        assert.isTrue(yield* dir.marker(started.value.id, "reap"))
        // The first prompt of a task is its header, the start instructions and the message, after the initialize line.
        const fs = yield* FileSystem.FileSystem
        const prompt = yield* fs.readFileString(`${dir.path(started.value.id)}/prompt`).pipe(Effect.orDie)
        const [init, first] = prompt.split("\n")
        assert.include(init ?? "", '"subtype":"initialize"')
        assert.include(first ?? "", "# S-1: A task")
        assert.include(first ?? "", "hello")
      }),
    ),
  )

  it.effect("a stop while the run is prepared gives its launch up", () =>
    run(
      Effect.gen(function* () {
        const runs = yield* Runs
        const repo = yield* RunRepo
        const id = yield* newTask({ status: "todo" })
        yield* send(id, "hello")
        assert.deepStrictEqual(yield* runs.stop(id), { stopped: true })
        yield* runs.launched(id)
        const stopped = yield* repo.latest(id)
        assert.isTrue(stopped._tag === "Some" && stopped.value.stop === "requested" && stopped.value.phase === "preparing")
        // Its end (the task's column, "Stopped by user") is the reactor's (plan task 2.6).
      }),
    ),
  )

  it.effect("/compact starts a compaction, which doesn't move the card; with no conversation there's nothing to compact", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* RunRepo
        const dir = yield* RunDir
        const id = yield* newTask({ status: "in_review", session: "s1" })
        const t = yield* send(id, "/compact keep the notes")
        assert.deepStrictEqual([t.status, t.running, t.steerable], ["in_review", true, false])
        const started = { value: some(yield* repo.latest(id)) }
        assert.strictEqual(started.value.kind, "compact")
        yield* (yield* Runs).launched(id)
        const spec = yield* dir.spec(started.value.id)
        assert.isFalse(spec?.args.includes("--input-format") ?? true)
        const fresh = yield* newTask({ status: "todo" })
        assert.strictEqual((yield* refusal(send(fresh, "/compact"))).reason, "no_conversation")
      }),
    ),
  )
})

describe("Runs.stop", () => {
  it.effect("interrupts the turn; the turn it cuts short is marked interrupted and closes the input", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const runs = yield* Runs
        assert.deepStrictEqual(yield* runs.stop(id), { stopped: true })
        const sent = yield* agent.input
        const first = sent[0]
        assert.strictEqual(sent.length, 1)
        assert.isTrue(typeof first === "object" && first !== null && "type" in first && first.type === "control_request")
        assert.isFalse(yield* agent.inputClosed)
        yield* output(agent, [result("error_during_execution", 0)])
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual((yield* agent.row).stop, "interrupted")
        const last = (yield* results(id)).at(-1)
        assert.isTrue(last?.type === "turn_result" && last.interrupted === true)
        // No run on a task: nothing to stop.
        assert.deepStrictEqual(yield* runs.stop(yield* newTask()), { stopped: false })
      }),
    ),
  )

  it.effect("a message waiting when stopped starts the next turn, which is no longer stopped", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const steer = only((yield* send(id, "do this instead")).steering)
        const repo = yield* RunRepo
        yield* repo.update(agent.run.id, { attention: "a question" })
        yield* (yield* Runs).stop(id)
        // The agent ends the interrupted turn, then starts the next with the message.
        yield* output(agent, [result("error_during_execution", 0)])
        assert.isFalse(yield* agent.inputClosed)
        yield* output(agent, [replay(steer.id, "do this instead")])
        let row = yield* agent.row
        // That turn goes ahead, so the run isn't stopped any more (and the user answered).
        assert.deepStrictEqual([row.stop, row.attention], ["none", null])
        yield* output(agent, [result("success", 0)])
        assert.isTrue(yield* agent.inputClosed)
        row = yield* agent.row
        assert.strictEqual(row.result_error, null)
      }),
    ),
  )

  it.effect("a message taken in before a stop doesn't undo it", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const steer = only((yield* send(id, "and this")).steering)
        yield* (yield* Runs).stop(id)
        // Taken in before the interrupt landed: the stop still ends the turn and the run.
        yield* output(agent, [replay(steer.id, "and this"), result("error_during_execution", 0)])
        assert.notStrictEqual((yield* agent.row).stop, "none")
        assert.isTrue(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("an earlier stop's grace doesn't cut a later one short; an agent that doesn't end its turn is stopped", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const steer = only((yield* send(id, "do this instead")).steering)
        const runs = yield* Runs
        yield* runs.stop(id)
        // The stop ends the turn, and the waiting message starts the next.
        yield* output(agent, [result("error_during_execution", 0), replay(steer.id, "do this instead")])
        yield* TestClock.adjust("5 seconds")
        // Stopped again: the first stop's time is up before this one's.
        yield* runs.stop(id)
        yield* TestClock.adjust("7500 millis")
        assert.isFalse(yield* agent.inputClosed)
        // This one's isn't, and its turn hasn't ended.
        yield* TestClock.adjust("5 seconds")
        yield* (yield* RunInput).settled(agent.run.id, "stop")
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual(STOP_GRACE, "10 seconds")
      }),
    ),
  )
})

describe("a Claude run's output", () => {
  it.effect("records the agent's reply, the session and the turn's end", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running({ task: yield* newTask({ running: true }) })
        yield* output(agent, [
          { type: "system", subtype: "init", session_id: "s7" },
          said("Done it."),
          result("success", 0.3, { session_id: "s7", result: "Done it." }),
        ])
        const t = yield* task(id)
        assert.strictEqual(t.session_id, "s7")
        assert.closeTo(t.cost_usd, 0.3, 1e-9)
        const row = yield* agent.row
        assert.deepStrictEqual([row.session_id, row.saw_result, row.between_turns, row.result_error], ["s7", true, true, null])
        assert.deepStrictEqual(
          (yield* items(id)).map((i) => i.type),
          ["assistant_message", "turn_result"],
        )
        // The offset is the end of the last line, saved with it.
        const fs = yield* FileSystem.FileSystem
        assert.strictEqual(row.out_offset, Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size))
        assert.isTrue(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("a line read again (the server stopped before more was saved) adds nothing twice", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        yield* output(agent, [said("Once.")])
        const handler = yield* RunOutput
        const row = yield* agent.row
        // The follower starts again from the saved offset, which is after the line: an older offset re-reads it, and
        // the item it made is replaced, not doubled.
        yield* handler.handle(row, yield* Schema.encodeEffect(Json)(said("Once.")).pipe(Effect.orDie), row.out_offset)
        const texts = (yield* items(id)).flatMap((i) => (i.type === "assistant_message" ? [i.text] : []))
        assert.isAtMost(texts.length, 2)
        assert.strictEqual(texts[0], "Once.")
      }),
    ),
  )

  it.effect("a resumed session's leftover background task doesn't end the run (HA-404); a later one does", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const leftover = { ...result("success", 0.1), num_turns: 0, duration_api_ms: 0, result: "", origin: { kind: "task-notification" } }
        yield* output(agent, [{ type: "system", subtype: "init", session_id: "s1" }, leftover])
        assert.isFalse(yield* agent.inputClosed)
        assert.strictEqual((yield* results(id)).length, 0)
        yield* output(agent, [{ type: "system", subtype: "init", session_id: "s1" }, replay("the prompt's id", "the prompt"), result("success", 0.2)])
        assert.isTrue(yield* agent.inputClosed)
      }),
    ),
  )

  it.effect("results before the prompt is taken in are other turns' (HA-405); one naming it ends its turn", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        const dir = yield* RunDir
        yield* dir.setAwaited(agent.run.id, "p1")
        yield* output(agent, [
          { ...result("success", 0.1), num_turns: 3, origin: { kind: "task-notification" } },
          { ...result("success", 0.1), num_turns: 2, origin: { kind: "peer", from: "a1" } },
          { ...result("success", 0.1), user_message_uuids: ["someone else's"] },
        ])
        assert.isFalse(yield* agent.inputClosed)
        assert.strictEqual((yield* results(id)).length, 0)
        assert.isFalse((yield* agent.row).saw_result)
        // Claude Code names the prompt in a frame of the turn it starts (here its init): that turn's result is the run's.
        yield* output(agent, [{ type: "system", subtype: "init", session_id: "s1", user_message_uuids: ["p1"] }])
        assert.strictEqual(yield* dir.awaited(agent.run.id), null)
        yield* output(agent, [{ ...result("success", 0.2), user_message_uuids: ["p1"] }])
        assert.isTrue(yield* agent.inputClosed)
        assert.strictEqual((yield* results(id)).length, 1)
      }),
    ),
  )

  it.effect("a result that names the prompt ends its turn; so does the replayed prompt, and a result naming no turn", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        {
          const { agent } = yield* running()
          yield* dir.setAwaited(agent.run.id, "p1")
          yield* output(agent, [{ ...result("success", 0.2), user_message_uuids: ["p1", "s2"] }])
          assert.isTrue(yield* agent.inputClosed)
        }
        {
          const { agent } = yield* running()
          yield* dir.setAwaited(agent.run.id, "p1")
          yield* output(agent, [replay("p1", "the prompt"), { ...result("success", 0.2), origin: { kind: "task-notification" } }])
          const row = yield* agent.row
          assert.deepStrictEqual([row.saw_result, row.between_turns], [true, true])
        }
        {
          // Claude Code failing before it takes the prompt in (a session it can't resume, say).
          const { agent } = yield* running()
          yield* dir.setAwaited(agent.run.id, "p1")
          yield* output(agent, [{ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0 }])
          assert.isTrue(yield* agent.inputClosed)
          assert.strictEqual((yield* agent.row).result_error, 'run ended with "error_during_execution"')
        }
      }),
    ),
  )

  it.effect("a session the model never answered is not resumed; a review thread's is kept", () =>
    run(
      Effect.gen(function* () {
        const notLoggedIn = {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in",
          duration_api_ms: 0,
          total_cost_usd: 0,
          session_id: "fresh",
        }
        const { task: id, agent } = yield* running({ task: yield* newTask({ running: true }) })
        yield* output(agent, [{ type: "system", subtype: "init", session_id: "fresh" }, notLoggedIn])
        assert.strictEqual((yield* task(id)).session_id, null)
        const review = yield* newTask({ running: true })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE tasks SET kind = 'review' WHERE id = ${review}`.pipe(Effect.orDie)
        const other = yield* running({ task: review })
        yield* output(other.agent, [{ type: "system", subtype: "init", session_id: "fresh" }, notLoggedIn])
        assert.strictEqual((yield* task(review)).session_id, "fresh")
      }),
    ),
  )

  it.effect("a turn's end closes the input even if it can't be recorded", () =>
    run(
      Effect.gen(function* () {
        const { agent } = yield* running()
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER no_end BEFORE UPDATE OF saw_result ON runs BEGIN SELECT RAISE(ABORT, 'disk full'); END`.pipe(Effect.orDie)
        yield* output(agent, [result("success", 0.1)])
        assert.isTrue(yield* agent.inputClosed)
        // Skipped: the follower goes on from after it.
        const row = yield* agent.row
        assert.isTrue(row.out_offset > 0)
      }),
    ),
  )

  it.effect("a request nobody answers is refused at once, so the agent isn't left waiting", () =>
    run(
      Effect.gen(function* () {
        const { agent } = yield* running()
        yield* output(agent, [{ type: "control_request", request_id: "r1", request: { subtype: "elicitation" } }])
        yield* output(agent, [{ type: "control_request", request_id: "r2", request: { subtype: "hook_callback" } }])
        assert.deepStrictEqual(yield* agent.input, [
          { type: "control_response", response: { subtype: "error", request_id: "r1", error: 'the board doesn\'t handle "elicitation" requests' } },
          { type: "control_response", response: { subtype: "error", request_id: "r2", error: 'the board doesn\'t handle "hook_callback" requests' } },
        ])
      }),
    ),
  )

  it.effect("Claude Code refusing the board's tools is said in the thread", () =>
    run(
      Effect.gen(function* () {
        const { task: id, agent } = yield* running()
        yield* output(agent, [{ type: "control_response", response: { subtype: "error", request_id: `huntaway-init-${agent.run.id}`, error: "unsupported" } }])
        const notices = (yield* items(id)).flatMap((i) => (i.type === "notice" ? [i.text] : []))
        assert.deepStrictEqual(notices, ["Claude Code didn't take the board's tools (unsupported), so this run goes on without them."])
      }),
    ),
  )
})
