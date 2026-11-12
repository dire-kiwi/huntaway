import { Effect, Result, Schema } from "effect"
import { Timestamp, WorkflowGraph, WorkflowNodeRun } from "@huntaway/contracts"
import { encodeColumns } from "../../../platform/columns.ts"
import { endNodes } from "../../../workflows/graph.ts"
import { readGraph } from "../../../workflows/read.ts"
import { RunRow, WorkflowRow } from "../../../workflows/WorkflowStore.ts"
import { decodeOld, keyOf } from "../family.ts"
import type { Family, TableCheck } from "../family.ts"
import { orDefault, orNull, readOld } from "./common.ts"

// Workflows and their runs (docs/plan/11-migration.md, Table by table). Graphs are read as the old reader read them
// (`Graph_from_json`, ported as `workflows/read.ts`): the node kinds from before column nodes (`set_status`, `trigger` on
// `status` or `finished`) become `column` nodes, with their `out` edges as `done`. Runs keep their old order (`rowid`) as
// `seq`. A run still running when the old server stopped is ended, as stopping it does, as interrupted by the move.

export const OldWorkflow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  name: Schema.String,
  enabled: orDefault(Schema.Finite, 1),
  graph: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type OldWorkflow = typeof OldWorkflow.Type

export const OldWorkflowRun = Schema.Struct({
  old_rowid: Schema.Int,
  id: Schema.String,
  workflow_id: Schema.String,
  task_id: Schema.String,
  source: Schema.String,
  state: Schema.String,
  head: orNull(Schema.String),
  task_run: orNull(Schema.String),
  graph: Schema.String,
  nodes: orDefault(Schema.String, "{}"),
  rounds: orDefault(Schema.String, "{}"),
  detail: orNull(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  finished_at: orNull(Schema.String),
})
export type OldWorkflowRun = typeof OldWorkflowRun.Type

/** Why a run that was running is ended. */
export const INTERRUPTED = "Interrupted by the move to the new server"

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeNodes = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Record(Schema.String, WorkflowNodeRun)))

/** A stored graph as the board keeps it; the failure says why it can't be read. */
export const convertGraph = (text: string): Result.Result<WorkflowGraph, string> =>
  Result.match(parseJson(text), { onFailure: (e) => Result.fail(e.message), onSuccess: readGraph })

/** A workflow as the new table has it: its graph converted, or as it was when it can't be read (the report lists it). */
export const convertWorkflow = (w: OldWorkflow): Readonly<Record<string, unknown>> => ({
  ...w,
  graph: Result.getOrElse(convertGraph(w.graph), () => w.graph),
})

/**
 * A run as the new table has it, `seq` its old `rowid`: its graph converted, and, if it was running, ended at `at` as
 * `stopRun` ends one (steps still to run skipped, steps running stopped, saying why).
 */
export const convertRun = (r: OldWorkflowRun, at: string): Readonly<Record<string, unknown>> => {
  const { old_rowid, ...rest } = r
  const graph = convertGraph(r.graph)
  const run = { ...rest, seq: old_rowid, graph: Result.getOrElse(graph, () => r.graph) }
  if (r.state !== "running") return run
  const ended = { ...run, state: "stopped", detail: INTERRUPTED, finished_at: at, updated_at: at }
  const nodes = decodeNodes(r.nodes)
  if (Result.isFailure(graph) || Result.isFailure(nodes)) return ended
  return { ...ended, nodes: endNodes({ graph: graph.success, nodes: nodes.success }, INTERRUPTED, Timestamp.make(at)).run.nodes }
}

const byId = keyOf("id")
const workflowRows: TableCheck = { row: WorkflowRow, json: { graph: WorkflowGraph }, key: byId }
const runRows: TableCheck = {
  row: Schema.Struct({ seq: Schema.Int, ...RunRow.fields }),
  json: { graph: WorkflowGraph, nodes: Schema.Record(Schema.String, WorkflowNodeRun), rounds: Schema.Record(Schema.String, Schema.Int) },
  key: byId,
}

export const workflows: Family = {
  name: "workflows",
  reads: ["workflows", "workflow_runs"],
  writes: ["workflows", "workflow_runs"],
  run: (io) =>
    Effect.gen(function* () {
      const found = yield* readOld(io, "workflows", OldWorkflow, byId)
      yield* io.write("workflows", workflowRows, yield* Effect.forEach(found, (w) => encodeColumns(convertWorkflow(w)), { concurrency: 1 }))
      const runs = io.old.tables.has("workflow_runs") ? yield* io.old.query(`SELECT rowid AS old_rowid, * FROM workflow_runs ORDER BY rowid`) : []
      yield* io.report.old("workflow_runs", runs.length)
      const decoded = yield* decodeOld(io.report, "workflow_runs", OldWorkflowRun, byId)(runs)
      yield* io.write("workflow_runs", runRows, yield* Effect.forEach(decoded, (r) => encodeColumns(convertRun(r, io.ctx.now)), { concurrency: 1 }))
    }),
}
