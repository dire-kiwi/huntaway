import { Context, Effect, Layer, Schema } from "effect"
import {
  ProjectId,
  TaskId,
  Timestamp,
  WorkflowGraph,
  WorkflowId,
  WorkflowNodeRun,
  WorkflowRunId,
  WorkflowRunSource,
  WorkflowRunState,
} from "@huntaway/contracts"
import type { Workflow } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, JsonColumn, rowsOf, toJson } from "../platform/columns.ts"
import { KEPT_RUNS } from "./graph.ts"
import type { RunState } from "./graph.ts"

// The `workflows` and `workflow_runs` tables (docs/plan/04-database.md; inventory 06, 3.1; huntaway's
// integrations/workflows/store.ts), and an agent step thread's MCP servers it doesn't get (`thread_tools`). A run's state
// is one row: its nodes and rounds as JSON, rewritten whole by `saveRun` (under the run's lock, `WorkflowEngine`).
// Statements only; `SqlError` and `SchemaError` are defects. Nothing here waits.

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] }

export const WorkflowRow = Schema.Struct({
  id: WorkflowId,
  project_id: ProjectId,
  name: Schema.String,
  enabled: Bit,
  graph: JsonColumn(WorkflowGraph, EMPTY_GRAPH),
  created_at: Timestamp,
  updated_at: Timestamp,
})

export const RunRow = Schema.Struct({
  id: WorkflowRunId,
  workflow_id: WorkflowId,
  task_id: TaskId,
  source: WorkflowRunSource,
  state: WorkflowRunState,
  head: Schema.NullOr(Schema.String),
  task_run: Schema.NullOr(Schema.String),
  graph: JsonColumn(WorkflowGraph, EMPTY_GRAPH),
  nodes: JsonColumn(Schema.Record(Schema.String, WorkflowNodeRun), {}),
  rounds: JsonColumn(Schema.Record(Schema.String, Schema.Int), {}),
  detail: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  finished_at: Schema.NullOr(Timestamp),
})

const workflows = rowsOf(WorkflowRow)
const runs = rowsOf(RunRow)
const ids = rowsOf(Schema.Struct({ task_id: TaskId }))

/** The keys of a map in order, so a run's JSON reads the same each time it's written. */
const sorted = <T>(m: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(m).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const first = <A>(found: Effect.Effect<ReadonlyArray<A>>) => Effect.map(found, (list) => list[0] ?? null)

const RUN_COLUMNS = "id, workflow_id, task_id, source, state, head, task_run, graph, nodes, rounds, detail, created_at, updated_at, finished_at"

export interface WorkflowStoreShape {
  /** A project's workflows, oldest first. */
  readonly list: (project: ProjectId) => Effect.Effect<ReadonlyArray<Workflow>>
  readonly get: (id: string) => Effect.Effect<Workflow | null>
  readonly insert: (w: Workflow) => Effect.Effect<void>
  readonly update: (id: WorkflowId, w: Pick<Workflow, "name" | "graph" | "enabled" | "updated_at">) => Effect.Effect<void>
  readonly delete: (id: WorkflowId) => Effect.Effect<void>
  readonly getRun: (id: string) => Effect.Effect<RunState | null>
  /** Adds a run; the workflow's finished runs on the task beyond the newest `KEPT_RUNS` go. */
  readonly insertRun: (run: RunState) => Effect.Effect<void>
  /** Writes a run's state, nodes, rounds, source and `task_run`. */
  readonly saveRun: (run: RunState) => Effect.Effect<void>
  /** The workflow's latest run on the task. */
  readonly latestRun: (workflow: WorkflowId, task: TaskId) => Effect.Effect<RunState | null>
  /** The workflow's latest runs on the task but `except`, newest first (at most `KEPT_RUNS`). With `done`, only finished ones. */
  readonly earlierRuns: (workflow: WorkflowId, task: TaskId, except: string, done?: boolean) => Effect.Effect<ReadonlyArray<RunState>>
  /** Runs in progress, on one task or every one, oldest first. */
  readonly running: (task: TaskId | null) => Effect.Effect<ReadonlyArray<RunState>>
  /** Every run on a task, newest first. */
  readonly runsOfTask: (task: TaskId) => Effect.Effect<ReadonlyArray<RunState>>
  /** The tasks a workflow has runs on. */
  readonly tasksOf: (workflow: WorkflowId) => Effect.Effect<ReadonlyArray<TaskId>>
  /** The project's MCP servers an agent step's thread doesn't get. */
  readonly setDisabledMcpServers: (thread: TaskId, names: ReadonlyArray<string>) => Effect.Effect<void>
}

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreShape>()("huntaway-server/workflows/WorkflowStore") {
  static readonly layer = Layer.effect(
    WorkflowStore,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const cols = sql.literal(RUN_COLUMNS)

      return WorkflowStore.of({
        list: (project) =>
          workflows(
            sql`SELECT id, project_id, name, enabled, graph, created_at, updated_at FROM workflows WHERE project_id = ${project} ORDER BY created_at, id`,
          ),
        get: (id) => first(workflows(sql`SELECT id, project_id, name, enabled, graph, created_at, updated_at FROM workflows WHERE id = ${id}`)),
        insert: (w) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO workflows ${sql.insert({
              id: w.id,
              project_id: w.project_id,
              name: w.name,
              enabled: w.enabled ? 1 : 0,
              graph: yield* toJson(w.graph),
              created_at: w.created_at,
              updated_at: w.updated_at,
            })}`
          }).pipe(Effect.orDie),
        update: (id, w) =>
          Effect.gen(function* () {
            yield* sql`UPDATE workflows SET name = ${w.name}, graph = ${yield* toJson(w.graph)}, enabled = ${w.enabled ? 1 : 0},
              updated_at = ${w.updated_at} WHERE id = ${id}`
          }).pipe(Effect.orDie),
        delete: (id) => sql`DELETE FROM workflows WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        getRun: (id) => first(runs(sql`SELECT ${cols} FROM workflow_runs WHERE id = ${id}`)),
        insertRun: (r) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO workflow_runs ${sql.insert({
              id: r.id,
              workflow_id: r.workflow_id,
              task_id: r.task_id,
              source: r.source,
              state: r.state,
              head: r.head,
              task_run: r.task_run,
              graph: yield* toJson(r.graph),
              nodes: yield* toJson(sorted(r.nodes)),
              rounds: yield* toJson(sorted(r.rounds)),
              detail: r.detail,
              created_at: r.created_at,
              updated_at: r.updated_at,
              finished_at: r.finished_at,
            })}`
            // Each workflow keeps its latest runs on each task.
            yield* sql`DELETE FROM workflow_runs WHERE workflow_id = ${r.workflow_id} AND task_id = ${r.task_id} AND state != 'running'
              AND seq NOT IN (SELECT seq FROM workflow_runs WHERE workflow_id = ${r.workflow_id} AND task_id = ${r.task_id}
                ORDER BY seq DESC LIMIT ${KEPT_RUNS})`
          }).pipe(Effect.orDie),
        saveRun: (r) =>
          Effect.gen(function* () {
            yield* sql`UPDATE workflow_runs SET state = ${r.state}, nodes = ${yield* toJson(sorted(r.nodes))}, rounds = ${yield* toJson(sorted(r.rounds))},
              detail = ${r.detail}, updated_at = ${r.updated_at}, finished_at = ${r.finished_at}, source = ${r.source}, task_run = ${r.task_run}
              WHERE id = ${r.id}`
          }).pipe(Effect.orDie),
        latestRun: (workflow, task) =>
          first(runs(sql`SELECT ${cols} FROM workflow_runs WHERE workflow_id = ${workflow} AND task_id = ${task} ORDER BY seq DESC LIMIT 1`)),
        earlierRuns: (workflow, task, except, done = false) =>
          runs(sql`SELECT ${cols} FROM workflow_runs WHERE workflow_id = ${workflow} AND task_id = ${task} AND id != ${except}
            ${done ? sql`AND state = 'done'` : sql``} ORDER BY seq DESC LIMIT ${KEPT_RUNS}`),
        running: (task) =>
          runs(
            task === null
              ? sql`SELECT ${cols} FROM workflow_runs WHERE state = 'running' ORDER BY seq`
              : sql`SELECT ${cols} FROM workflow_runs WHERE state = 'running' AND task_id = ${task} ORDER BY seq`,
          ),
        runsOfTask: (task) => runs(sql`SELECT ${cols} FROM workflow_runs WHERE task_id = ${task} ORDER BY seq DESC`),
        tasksOf: (workflow) =>
          Effect.map(ids(sql`SELECT DISTINCT task_id FROM workflow_runs WHERE workflow_id = ${workflow}`), (rows) => rows.map((r) => r.task_id)),
        setDisabledMcpServers: (thread, names) =>
          Effect.gen(function* () {
            const text = yield* toJson(names)
            yield* sql`INSERT INTO thread_tools (task_id, disabled_mcp_servers) VALUES (${thread}, ${text})
              ON CONFLICT(task_id) DO UPDATE SET disabled_mcp_servers = excluded.disabled_mcp_servers`
          }).pipe(Effect.orDie),
      })
    }),
  )
}
