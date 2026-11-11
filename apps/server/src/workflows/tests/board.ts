import { Effect, FileSystem, Result, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { ProjectId, TaskId, Timestamp, WorkflowId, WorkflowRunId } from "@huntaway/contracts"
import type { Item, Task, Workflow, WorkflowNodeRun } from "@huntaway/contracts"
import { fakeAgent, git, gitRepo, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Checkpoints } from "../../git/Checkpoints.ts"
import { Reactor } from "../../lifecycle/Reactor.ts"
import { toJson } from "../../platform/columns.ts"
import type { ServerConfigShape } from "../../platform/ServerConfig.ts"
import { ReviewRepo } from "../../review/ReviewRepo.ts"
import { RunEnds } from "../../runs/RunEnds.ts"
import { RunOutput } from "../../runs/RunOutput.ts"
import { Runs } from "../../runs/Runs.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { ThreadReaders } from "../../threads/ThreadReaders.ts"
import { Threads } from "../../threads/Threads.ts"
import { readGraph } from "../read.ts"
import { WorkflowEngine } from "../WorkflowEngine.ts"
import { Workflows } from "../Workflows.ts"
import { WorkflowStore } from "../WorkflowStore.ts"
import type { RunState } from "../graph.ts"

// What the workflows area's board tests share (huntaway's integrations/workflows/testing.ts): a project that uses
// workflows and a task with a worktree that has a commit of its own, workflows made from graphs as agents give them, a
// run's state set up by hand, an agent step's thread run as a scripted agent, and waiting for what follows. A test board
// has no ia-shim: a run the engine starts registers (its prompt is in its thread) and then fails to launch, which ends an
// agent step as failed through the reactor; a step that does its work is a scripted agent ended through `RunEnds`.

export const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
export const PROJECT = ProjectId.make("pr")
export const TASK = TaskId.make("t1")
const Json = Schema.fromJsonString(Schema.Unknown)

/** A test board's services. */
export const onBoard = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | TestServices>,
  config: Partial<ServerConfigShape> = {},
) => effect.pipe(Effect.scoped, Effect.provide(TestBoard(config)))

type TestServices =
  | Workflows
  | WorkflowEngine
  | WorkflowStore
  | Reactor
  | Runs
  | RunEnds
  | RunOutput
  | Checkpoints
  | TaskRepo
  | ReviewRepo
  | Threads
  | ThreadReaders

export interface Setup {
  readonly status?: Task["status"]
  /** The project's columns. */
  readonly project?: Readonly<Record<string, unknown>>
  /** The task's columns. */
  readonly task?: Readonly<Record<string, unknown>>
  /** The branch has no commits of its own. */
  readonly elsewhere?: boolean
}

/**
 * Project X ("pr", profile "p", using workflows) and its task X-1 ("t1", "Fix the thing") in `status` (In review), whose
 * worktree is a repository at a commit of its own on `ia/x-1`, branched from `main`. The worktree's folder.
 */
export const workable = (options: Setup = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dir = yield* gitRepo
    yield* git(dir, ["checkout", "-q", "-b", "ia/x-1"])
    if (options.elsewhere !== true) yield* git(dir, ["commit", "-q", "--allow-empty", "-m", "work"])
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    yield* sql`INSERT INTO projects ${sql.insert({
      id: PROJECT,
      profile_id: "p",
      name: "x",
      key: "X",
      repo_path: dir,
      scratch_path: `${dir}/.s`,
      worktrees_root: `${dir}/.w`,
      base_branch: "main",
      use_workflows: 1,
      is_git: 1,
      created_at: AT,
      ...options.project,
    })}`
    yield* sql`INSERT INTO tasks ${sql.insert({
      id: TASK,
      profile_id: "p",
      project_id: PROJECT,
      number: 1,
      title: "Fix the thing",
      description: "Make it work.",
      status: options.status ?? "in_review",
      use_worktree: 1,
      worktree_state: "ready",
      worktree_path: dir,
      branch: "ia/x-1",
      last_activity_at: AT,
      created_at: AT,
      updated_at: AT,
      ...options.task,
    })}`
    return dir
  }).pipe(Effect.orDie)

/** A workflow of the project made from `graph` as an agent gives it (read leniently: old kinds and defaults). */
export const make = (graph: unknown, name = "Review", enabled = true) =>
  Effect.gen(function* () {
    const g = readGraph(graph)
    if (Result.isFailure(g)) return yield* Effect.die(g.failure)
    return yield* (yield* Workflows).create({ project_id: PROJECT, name, graph: g.success, enabled })
  }).pipe(Effect.orDie)

/** Sets columns of a task (JSON ones given as values). */
export const setTask = (id: TaskId, columns: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const row: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(columns)) row[k] = v !== null && typeof v === "object" ? yield* toJson(v) : typeof v === "boolean" ? (v ? 1 : 0) : v
    yield* sql`UPDATE tasks SET ${sql.update(row)} WHERE id = ${id}`
  }).pipe(Effect.orDie)

export const setProject = (columns: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE projects SET ${sql.update(columns)} WHERE id = ${PROJECT}`
  }).pipe(Effect.orDie)

export const task = (id: TaskId = TASK) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })

/**
 * Waits until what was started has started or given up, the engine's background work is done, and the reactor has
 * handled what followed: a few times round, as each can start more of the others.
 */
export const settle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const runs = yield* Runs
  const reactor = yield* Reactor
  const engine = yield* WorkflowEngine
  const checkpoints = yield* Checkpoints
  for (let i = 0; i < 6; i++) {
    yield* reactor.idle
    yield* engine.idle
    for (const { id } of yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks`.pipe(Effect.orDie)) {
      yield* runs.launched(id)
      yield* checkpoints.settled(id)
    }
    yield* reactor.idle
    yield* engine.idle
  }
})

/** The workflow's runs on the task, newest first. */
export const runsOf = (w: Pick<Workflow, "id">, t: TaskId = TASK) =>
  Effect.map(
    Effect.flatMap(WorkflowStore.asEffect(), (s) => s.runsOfTask(t)),
    (all) => all.filter((r) => r.workflow_id === w.id),
  )

/** The workflow's latest run on the task. */
export const latest = (w: Pick<Workflow, "id">, t: TaskId = TASK) =>
  Effect.flatMap(runsOf(w, t), (all) => (all[0] === undefined ? Effect.die("no run") : Effect.succeed(all[0])))

/** Each node's state (and port, if it has one) in a run. */
export const states = (run: RunState) =>
  Object.fromEntries(Object.entries(run.nodes).map(([id, r]) => [id, r.port !== undefined ? `${r.state}:${r.port}` : r.state]))

/** The notices said in a thread. */
export const notices = (id: TaskId = TASK) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Threads).stored(id).pipe(Effect.orDie)
    return stored.entries.map((e): Item => e.item).flatMap((i) => (i.type === "notice" ? [i.text] : []))
  })

/** The messages the thread was sent, in order. */
export const sent = (id: TaskId = TASK) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Threads).stored(id).pipe(Effect.orDie)
    return stored.entries.map((e): Item => e.item).flatMap((i) => (i.type === "user_message" ? [i.text] : []))
  })

/** A run of `w` set up by hand on the task: `nodes` as given (the others pending), running, `source` manual. */
export const runByHand = (w: Workflow, nodes: Readonly<Record<string, WorkflowNodeRun>>, over: Partial<RunState> = {}) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const all: Record<string, WorkflowNodeRun> = {}
    for (const n of w.graph.nodes) {
      if (["text", "task", "project_prompt", "compose", "join", "switch"].includes(n.kind)) continue
      all[n.id] = nodes[n.id] ?? { state: "pending" }
    }
    const run: RunState = {
      id: WorkflowRunId.make(`r${(yield* store.runsOfTask(TASK)).length + 1}`),
      workflow_id: WorkflowId.make(w.id),
      task_id: TASK,
      source: "manual",
      state: "running",
      head: null,
      task_run: null,
      graph: w.graph,
      nodes: all,
      rounds: {},
      detail: null,
      created_at: AT,
      updated_at: AT,
      finished_at: null,
      ...over,
    }
    yield* store.insertRun(run)
    return run
  })

/** A workflow step's thread under the task, as the engine makes it. */
export const stepThread = (id: string, title = "Reviewer (Review) of X-1") =>
  Effect.gen(function* () {
    const thread = TaskId.make(id)
    yield* (yield* ReviewRepo).insertThread(
      thread,
      {
        profile_id: (yield* task()).profile_id,
        project_id: PROJECT,
        parent_id: TASK,
        task_type: "workflow",
        title,
        description: "",
        model: null,
        effort: null,
        claude_config_id: null,
      },
      AT,
    )
    return thread
  })

/** A step's thread's run, as a scripted agent. */
export const stepAgent = (thread: TaskId) => fakeAgent({ task: thread, kind: "review" })

/** The agent's lines, handled as the follower hands them. */
export const output = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    for (const line of lines) {
      yield* agent.write([line])
      const end = Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size)
      yield* handler.handle(yield* agent.row, yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie), end)
    }
  })

export const RESULT = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, session_id: "s1" }
export const said = (text: string) => ({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text }] }, session_id: "s1" })

/** The agent's run ends (a turn ended: fine, after saying `text` if given), as the follower ends it; then what follows. */
export const ends = (agent: FakeAgent, text: string | null = null, ok = true) =>
  Effect.gen(function* () {
    if (text !== null) yield* output(agent, [said(text)])
    if (ok) yield* output(agent, [RESULT])
    yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: agent.run.task_id, exit: { code: ok ? 0 : 1, signal: null }, errorTail: "" })
    yield* settle
  })

/** The engine, for a test. */
export const engine = WorkflowEngine.asEffect()
