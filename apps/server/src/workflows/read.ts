import { Effect, Result, Schema } from "effect"
import { Status, WorkflowCheck, WorkflowDoneWhen, WorkflowJoin, WorkflowOutput } from "@huntaway/contracts"
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "@huntaway/contracts"

// Reading a graph an agent gives (`create_workflow`, `update_workflow`) or an old row holds (huntaway's
// integrations/workflows/model.ts `Graph_from_json`): a kind's fields defaulted as the old reader did, null read as not
// given, and the kinds from before column nodes read as column nodes (`trigger` on `status` or `finished`,
// `set_status`), with their `out` edges as `done`. What it gives is checked by `check.ts`.

const def = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))
const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const place = {
  id: Schema.String,
  x: def(Schema.Finite, 0),
  y: def(Schema.Finite, 0),
  join: opt(WorkflowJoin),
  label: opt(Schema.String),
}

const NodeIn = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("trigger"), on: Schema.Literals(["manual", "status", "finished"]), status: opt(Schema.String), ...place }),
  Schema.Struct({
    kind: Schema.Literal("column"),
    status: Schema.String,
    prompt: def(Schema.String, ""),
    done_when: opt(WorkflowDoneWhen),
    max_rounds: opt(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    ...place,
  }),
  Schema.Struct({ kind: Schema.Literal("condition"), check: WorkflowCheck, value: opt(Schema.String), ...place }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    name: Schema.String,
    prompt: def(Schema.String, ""),
    output: def(WorkflowOutput, "text"),
    claude_config_id: opt(Schema.String),
    model: opt(Schema.String),
    effort: opt(Schema.String),
    skills: opt(Schema.Array(Schema.String)),
    disabled_mcp_servers: opt(Schema.Array(Schema.String)),
    tab: opt(Schema.String),
    input_only: opt(Schema.Boolean),
    keep_conversation: opt(Schema.Boolean),
    ...place,
  }),
  Schema.Struct({ kind: Schema.Literal("split"), weights: def(Schema.Array(Schema.Finite), [50, 50]), each_run: opt(Schema.Boolean), ...place }),
  Schema.Struct({
    kind: Schema.Literal("send_to_task"),
    message: def(Schema.String, ""),
    max_rounds: def(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), 2),
    ...place,
  }),
  Schema.Struct({ kind: Schema.Literal("set_status"), status: Schema.String, ...place }),
  Schema.Struct({ kind: Schema.Literal("open_pr"), title: def(Schema.String, ""), body: def(Schema.String, ""), draft: opt(Schema.Boolean), ...place }),
  Schema.Struct({ kind: Schema.Literal("text"), text: def(Schema.String, ""), ...place }),
  Schema.Struct({ kind: Schema.Literal("task"), ...place }),
  Schema.Struct({ kind: Schema.Literal("project_prompt"), which: def(Schema.Literals(["start", "review", "merge"]), "start"), ...place }),
  Schema.Struct({ kind: Schema.Literal("compose"), template: def(Schema.String, ""), ...place }),
  Schema.Struct({
    kind: Schema.Literal("join"),
    separator: def(Schema.String, "\n\n"),
    count: def(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), 2),
    ...place,
  }),
  Schema.Struct({ kind: Schema.Literal("switch"), check: WorkflowCheck, value: opt(Schema.String), ...place }),
])
type NodeIn = typeof NodeIn.Type

const EdgeIn = Schema.Struct({ from: Schema.String, port: def(Schema.String, "out"), to: Schema.String, input: opt(Schema.String) })

const GraphIn = Schema.Struct({ nodes: def(Schema.Array(Schema.Unknown), []), edges: def(Schema.Array(EdgeIn), []) })

const decodeGraph = Schema.decodeUnknownResult(GraphIn)
const decodeNode = Schema.decodeUnknownResult(NodeIn)
const isStatus = Schema.is(Status)

/** The key only when it's given. */
const some = <K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> => {
  const out: Partial<Record<K, V>> = {}
  if (value !== null && value !== undefined) out[key] = value
  return out
}

/** One node, as the board keeps it. A string says why it can't be read. */
const node = (n: NodeIn): WorkflowNode | string => {
  const where = { id: n.id, x: n.x, y: n.y, ...(n.join === "all" ? { join: "all" as const } : {}), ...some("label", n.label) }
  const column = (status: string): WorkflowNode | string =>
    isStatus(status) ? { kind: "column", status, prompt: "", ...where } : `unknown column \`${status}\``
  switch (n.kind) {
    case "trigger":
      if (n.on === "manual") return { kind: "trigger", on: "manual", ...where }
      // From before column nodes: a start on a column, or on the agent finishing (in In progress), is that column's node.
      if (n.on === "finished") return column("in_progress")
      return n.status === null || n.status === undefined ? "a start on a column needs its column (`status`)" : column(n.status)
    case "set_status":
      // A move is an edge into the column's node.
      return column(n.status)
    case "column": {
      const s = n.status
      if (!isStatus(s)) return `unknown column \`${s}\``
      return {
        kind: "column",
        status: s,
        prompt: n.prompt,
        ...(n.done_when === "finish" ? { done_when: "finish" as const } : {}),
        ...some("max_rounds", n.max_rounds),
        ...where,
      }
    }
    case "condition":
    case "switch":
      return { kind: n.kind, check: n.check, ...some("value", n.value), ...where }
    case "agent":
      return {
        kind: "agent",
        name: n.name,
        prompt: n.prompt,
        output: n.output,
        ...some("claude_config_id", n.claude_config_id),
        ...some("model", n.model),
        ...some("effort", n.effort),
        ...(n.skills !== null && n.skills !== undefined && n.skills.length > 0 ? { skills: n.skills } : {}),
        ...(n.disabled_mcp_servers !== null && n.disabled_mcp_servers !== undefined && n.disabled_mcp_servers.length > 0
          ? { disabled_mcp_servers: n.disabled_mcp_servers }
          : {}),
        ...some("tab", n.tab),
        ...(n.input_only === true ? { input_only: true } : {}),
        ...(n.keep_conversation === true ? { keep_conversation: true } : {}),
        ...where,
      }
    case "split":
      return { kind: "split", weights: n.weights, ...(n.each_run === true ? { each_run: true } : {}), ...where }
    case "send_to_task":
      return { kind: "send_to_task", message: n.message, max_rounds: n.max_rounds, ...where }
    case "open_pr":
      return { kind: "open_pr", title: n.title, body: n.body, ...(n.draft === true ? { draft: true } : {}), ...where }
    case "text":
      return { kind: "text", text: n.text, ...where }
    case "task":
      return { kind: "task", ...where }
    case "project_prompt":
      return { kind: "project_prompt", which: n.which, ...where }
    case "compose":
      return { kind: "compose", template: n.template, ...where }
    case "join":
      return { kind: "join", separator: n.separator, count: n.count, ...where }
  }
  return "a node of no kind a workflow has"
}

/** A graph given as JSON, read as the board keeps it; the failure says why it can't be read. */
export const readGraph = (v: unknown): Result.Result<WorkflowGraph, string> => {
  const g = decodeGraph(v)
  if (Result.isFailure(g)) return Result.fail(g.failure.message)
  const nodes: Array<WorkflowNode> = []
  // The `out` of a start or a move read as a column node is its `done`.
  const readAsColumn = new Set<string>()
  for (const raw of g.success.nodes) {
    const n = decodeNode(raw)
    if (Result.isFailure(n)) return Result.fail(n.failure.message)
    const read = node(n.success)
    if (typeof read === "string") return Result.fail(read)
    if (n.success.kind === "set_status" || (n.success.kind === "trigger" && n.success.on !== "manual")) readAsColumn.add(n.success.id)
    nodes.push(read)
  }
  const edges: Array<WorkflowEdge> = []
  for (const e of g.success.edges) {
    if (e.input !== null && e.input !== undefined) edges.push({ from: e.from, port: e.port, to: e.to, input: e.input })
    else edges.push({ from: e.from, port: e.port === "out" && readAsColumn.has(e.from) ? "done" : e.port, to: e.to })
  }
  return Result.succeed({ nodes, edges })
}
