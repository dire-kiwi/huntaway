import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { vi } from "vite-plus/test"
import { ProjectId, TaskId } from "@huntaway/contracts"
import { AT, importOld, onBoard } from "../../../../tests/importLegacy/importOld.ts"
import { WorkflowStore } from "../../../workflows/WorkflowStore.ts"
import { convertGraph, convertRun, INTERRUPTED } from "./workflows.ts"
import type { OldWorkflowRun } from "./workflows.ts"

vi.mock("./index.ts", () => import("../../../../tests/importLegacy/families.ts"))

// A graph from before column nodes: a start on In review, a reviewer, then a move to Done.
const LEGACY_GRAPH = `{"nodes":[{"id":"t","kind":"trigger","on":"status","status":"in_review","x":1,"y":2},
  {"id":"a","kind":"agent","name":"Reviewer","output":"verdict"},{"id":"s","kind":"set_status","status":"done"}],
  "edges":[{"from":"t","port":"out","to":"a"},{"from":"a","port":"pass","to":"s"}]}`

const NOW = "2026-11-12T00:00:00.000Z"

const oldRun = (fields: Partial<OldWorkflowRun>): OldWorkflowRun => ({
  old_rowid: 1,
  id: "r1",
  workflow_id: "w1",
  task_id: "t1",
  source: "status",
  state: "done",
  head: null,
  task_run: null,
  graph: LEGACY_GRAPH,
  nodes: "{}",
  rounds: "{}",
  detail: null,
  created_at: AT,
  updated_at: AT,
  finished_at: AT,
  ...fields,
})

describe("workflows: conversions", () => {
  it.each([
    [
      "a start on a column and a move become column nodes, their out edges done",
      LEGACY_GRAPH,
      {
        nodes: [
          { kind: "column", status: "in_review", prompt: "", id: "t", x: 1, y: 2 },
          { kind: "agent", name: "Reviewer", prompt: "", output: "verdict", id: "a", x: 0, y: 0 },
          { kind: "column", status: "done", prompt: "", id: "s", x: 0, y: 0 },
        ],
        edges: [
          { from: "t", port: "done", to: "a" },
          { from: "a", port: "pass", to: "s" },
        ],
      },
    ],
    [
      "a start on the agent finishing is In progress' column; a start by hand stays",
      `{"nodes":[{"id":"f","kind":"trigger","on":"finished"},{"id":"m","kind":"trigger","on":"manual"}],"edges":[]}`,
      {
        nodes: [
          { kind: "column", status: "in_progress", prompt: "", id: "f", x: 0, y: 0 },
          { kind: "trigger", on: "manual", id: "m", x: 0, y: 0 },
        ],
        edges: [],
      },
    ],
  ])("%s", (_, text, expected) => {
    expect(Result.getOrThrow(convertGraph(text))).toEqual(expected)
  })

  it.each([
    ["text that is not JSON", "{nodes"],
    ["a move to no column", `{"nodes":[{"id":"s","kind":"set_status","status":"nowhere"}],"edges":[]}`],
  ])("a graph that can't be read: %s", (_, text) => {
    expect(Result.isFailure(convertGraph(text))).toBe(true)
  })

  it("a running run is ended as interrupted: steps running stopped, steps to run skipped", () => {
    const run = convertRun(
      oldRun({
        old_rowid: 7,
        state: "running",
        finished_at: null,
        nodes: `{"t":{"state":"done","start":true},"a":{"state":"running","thread_id":"t9","port":"x"}}`,
      }),
      NOW,
    )
    expect(run).toMatchObject({ seq: 7, state: "stopped", detail: INTERRUPTED, finished_at: NOW, updated_at: NOW })
    expect(run["nodes"]).toEqual({
      t: { state: "done", start: true },
      a: { state: "stopped", thread_id: "t9", text: INTERRUPTED, finished_at: NOW },
      s: { state: "skipped" },
    })
  })

  it("a finished run is kept as it was, its graph converted", () => {
    const run = convertRun(oldRun({ old_rowid: 3, nodes: `{"t":{"state":"done"}}` }), NOW)
    expect(run).toMatchObject({ seq: 3, state: "done", detail: null, finished_at: AT, nodes: `{"t":{"state":"done"}}` })
    expect(run["graph"]).toMatchObject({ nodes: [{ kind: "column", status: "in_review" }, { kind: "agent" }, { kind: "column", status: "done" }] })
    expect(run).not.toHaveProperty("old_rowid")
  })
})

describe("workflows: import", () => {
  it.effect("a legacy graph reads back as column nodes, and runs keep their old order, the running one interrupted", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld((old) =>
        Effect.gen(function* () {
          yield* old.insert("workflows", { id: "w1", project_id: "j1", name: "Review", enabled: 1, graph: LEGACY_GRAPH, created_at: AT, updated_at: AT })
          // Inserted newest id first: the order is the rowid's, not the id's or the time's.
          for (const [id, state, nodes] of [
            ["rb", "done", `{"t":{"state":"done"},"a":{"state":"done","port":"pass"},"s":{"state":"done"}}`],
            ["ra", "running", `{"t":{"state":"done"},"a":{"state":"running","thread_id":"t1"}}`],
          ] as const)
            yield* old.insert("workflow_runs", {
              id,
              workflow_id: "w1",
              task_id: "t1",
              source: "status",
              state,
              graph: LEGACY_GRAPH,
              nodes,
              created_at: AT,
              updated_at: AT,
              finished_at: state === "done" ? AT : null,
            })
        }),
      )
      expect(report.failures).toEqual([])
      expect(report.json).toEqual([])
      expect(report.tables["workflows"]).toEqual({ old: 1, written: 1, withheld: 0 })
      expect(report.tables["workflow_runs"]).toEqual({ old: 2, written: 2, withheld: 0 })
      const { list, runsOfTask, running } = yield* Effect.gen(function* () {
        const store = yield* WorkflowStore
        return { list: yield* store.list(ProjectId.make("j1")), runsOfTask: yield* store.runsOfTask(TaskId.make("t1")), running: yield* store.running(null) }
      }).pipe(Effect.provide(onBoard(dataDir, WorkflowStore.layer)))
      expect(list.map((w) => w.graph.nodes.map((n) => n.kind))).toEqual([["column", "agent", "column"]])
      expect(list[0]?.graph.edges[0]).toEqual({ from: "t", port: "done", to: "a" })
      expect(runsOfTask.map((r) => [r.id, r.state])).toEqual([
        ["ra", "stopped"],
        ["rb", "done"],
      ])
      expect(runsOfTask[0]).toMatchObject({ detail: INTERRUPTED, nodes: { a: { state: "stopped", text: INTERRUPTED }, s: { state: "skipped" } } })
      expect(runsOfTask[1]?.graph.nodes.map((n) => n.kind)).toEqual(["column", "agent", "column"])
      expect(running).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
