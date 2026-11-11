import { Result } from "effect"
import {
  DocumentLabel,
  Effort,
  Status,
  workflowDataInputs,
  workflowDataOutputs,
  WORKFLOW_MAX_WEIGHT,
  WORKFLOW_PATHS,
  MAX_JOIN,
  templateInputs,
} from "@huntaway/contracts"
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { afterMerge, agentWorks, flowEdges, graphNode, isData, MAX_AGENTS, MAX_NODES, MAX_ROUNDS, MAX_TEXT, ports, statusLabel } from "./graph.ts"

// Checking a workflow that's given (inventory 06, 2.1 Validation; huntaway's integrations/workflows/check.ts): its name
// and its graph, against the project's agent configs, tidied (blank settings dropped, positions that aren't numbers
// put at 0). Pure: a failure is the reason, which the caller gives as `Invalid`.

/** Most skills an agent step can be asked to use. */
export const MAX_SKILLS = 10

const chars = (s: string) => Array.from(s).length
const bytes = (s: string) => new TextEncoder().encode(s).length

/** Whether an agent step's model is a model's name, given to the agent's command line as it is: not an option. */
export const modelOk = (m: string): boolean => chars(m) <= 100 && !m.startsWith("-") && !/[\s\p{Cc}]/u.test(m)

/** `s`, cut to at most `max` bytes of UTF-8 between characters. */
export const cutBytes = (s: string, max: number): string => {
  if (bytes(s) <= max) return s
  let out = ""
  let n = 0
  for (const ch of s) {
    n += bytes(ch)
    if (n > max) break
    out += ch
  }
  return out
}

/** A skill's name as a step keeps it: trimmed, without a leading `/` or `$`. */
export const skillName = (s: string): string => s.trim().replace(/^[/$]+/, "")

/** A workflow's name, trimmed: 1 to 100 characters. */
export const checkName = (v: string): Result.Result<string, string> => {
  const n = v.trim()
  return n !== "" && chars(n) <= 100 ? Result.succeed(n) : Result.fail("name must be 1 to 100 characters")
}

const TASK_TYPES = ["scratch"]
const LABELS: ReadonlyArray<string> = DocumentLabel.literals
const EFFORTS: ReadonlyArray<string> = Effort.literals
const STATUSES: ReadonlyArray<string> = Status.literals
const SWITCH_CHECKS = ["has_pr", "task_type", "label"]

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t === undefined || t === "" ? undefined : t
}

/** What a node's check needs as its value: a task type or a label; undefined for a check that takes none. */
const checkValue = (what: string, id: string, check: string, value: string | undefined): Result.Result<string | undefined, string> => {
  const v = trimmed(value)
  if (check === "task_type") {
    return v === "code" || (v !== undefined && TASK_TYPES.includes(v))
      ? Result.succeed(v)
      : Result.fail(`${what} ${id} needs a task type: code or ${TASK_TYPES.join(", ")}`)
  }
  if (check === "label") return v !== undefined && LABELS.includes(v) ? Result.succeed(v) : Result.fail(`${what} ${id} needs a label: ${LABELS.join(", ")}`)
  return Result.succeed(undefined)
}

const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => {
  const out: Partial<Record<K, V>> = {}
  if (value !== undefined) out[key] = value
  return out
}

/** What a node is when tidied, or why it's refused. `g` is the graph it's in (for its wires). */
const checkNode = (n: WorkflowNode, g: WorkflowGraph, configs: ReadonlyArray<string>): Result.Result<WorkflowNode, string> => {
  const id = n.id.trim()
  if (id === "" || id.length > 40 || !/^[A-Za-z0-9_-]+$/.test(id)) return Result.fail(`node id "${id}" must be 1 to 40 letters, digits, - or _`)
  const x = Number.isFinite(n.x) && Number.isFinite(n.y) ? n.x : 0
  const y = Number.isFinite(n.x) && Number.isFinite(n.y) ? n.y : 0
  // Only a data node has a label of its own: a step's name says what it is.
  const label = isData(n) ? trimmed(n.label) : undefined
  if (label !== undefined && chars(label) > 60) return Result.fail(`value ${id}'s name is longer than 60 characters`)
  const where = { id, x, y, ...(n.join === "all" ? { join: "all" as const } : {}), ...opt("label", label) }
  switch (n.kind) {
    case "trigger":
      return Result.succeed({ kind: "trigger", on: "manual", ...where })
    case "column": {
      const status = n.status
      if (!STATUSES.includes(status)) return Result.fail(`column ${id} needs a column: one of ${STATUSES.join(", ")}`)
      if (status === "done" && n.prompt.trim() !== "") return Result.fail(`column ${id} can't have a prompt: the agent has no work in Done`)
      if (bytes(n.prompt) > MAX_TEXT) return Result.fail(`column ${id}'s prompt is longer than ${MAX_TEXT} bytes`)
      if (status === "needs_attention" && n.prompt.trim() !== "") {
        return Result.fail(`column ${id} can't have a prompt: in Needs attention the agent waits for the user`)
      }
      const works = agentWorks(n, g)
      if (works && status === "ready_for_merge" && n.done_when === "finish") {
        return Result.fail(`column ${id}'s work is done when the task is merged, not when the agent says so`)
      }
      const doneWhen = works && n.done_when === "finish" ? { done_when: "finish" as const } : {}
      // Only edges into In progress give the agent work.
      const rounds = status === "in_progress" ? n.max_rounds : undefined
      if (rounds !== undefined && (rounds < 1 || rounds > MAX_ROUNDS))
        return Result.fail(`column ${id} can give the agent its work 1 to ${MAX_ROUNDS} times in a row`)
      return Result.succeed({ kind: "column", status, prompt: n.prompt, ...doneWhen, ...opt("max_rounds", rounds), ...where })
    }
    case "condition":
    case "switch": {
      const what = n.kind === "switch" ? "switch" : "condition"
      if (n.kind === "switch" && !SWITCH_CHECKS.includes(n.check)) return Result.fail(`switch ${id} checks ${SWITCH_CHECKS.join(", ")}`)
      const value = checkValue(what, id, n.check, n.value)
      if (Result.isFailure(value)) return Result.fail(value.failure)
      return Result.succeed({ kind: n.kind, check: n.check, ...opt("value", value.success), ...where })
    }
    case "agent": {
      const name = n.name.trim()
      if (name === "" || chars(name) > 60) return Result.fail(`agent step ${id} needs a name of 1 to 60 characters`)
      if (bytes(n.prompt) > MAX_TEXT) return Result.fail(`agent step ${id}'s prompt is longer than ${MAX_TEXT} bytes`)
      const config = trimmed(n.claude_config_id)
      if (config !== undefined && !configs.includes(config)) {
        return Result.fail(`agent step ${id}'s claude_config_id ${config} isn't one of the project's (or profile's) agent configs`)
      }
      const model = trimmed(n.model)
      // Given to the agent's command line as it is: a name, not an option.
      if (model !== undefined && !modelOk(model)) return Result.fail(`agent step ${id}'s model must be a model's name of up to 100 characters, without spaces`)
      const effort = trimmed(n.effort)
      if (effort !== undefined && !EFFORTS.includes(effort)) return Result.fail(`agent step ${id}'s effort must be one of ${EFFORTS.join(", ")}`)
      const skills = (n.skills ?? []).filter((s) => s.trim() !== "").map(skillName)
      if (skills.length > MAX_SKILLS) return Result.fail(`agent step ${id} has more than ${MAX_SKILLS} skills`)
      const off = [...new Set((n.disabled_mcp_servers ?? []).map((s) => s.trim()).filter((s) => s !== ""))]
      if (off.length > 50 || off.some((s) => chars(s) > 100)) {
        return Result.fail(`agent step ${id} turns off more than 50 MCP servers, or one with a name over 100 characters`)
      }
      const tab = trimmed(n.tab)
      if (tab !== undefined && chars(tab) > 30) return Result.fail(`agent step ${id}'s tab name is longer than 30 characters`)
      return Result.succeed({
        kind: "agent",
        name,
        prompt: n.prompt,
        output: n.output,
        ...opt("claude_config_id", config),
        ...opt("model", model),
        ...opt("effort", effort),
        ...(skills.length > 0 ? { skills } : {}),
        ...(off.length > 0 ? { disabled_mcp_servers: off } : {}),
        ...opt("tab", tab),
        ...(n.input_only === true ? { input_only: true } : {}),
        ...(n.keep_conversation === true ? { keep_conversation: true } : {}),
        ...where,
      })
    }
    case "split":
      if (n.weights.length < 2 || n.weights.length > WORKFLOW_PATHS.length) return Result.fail(`A/B test ${id} has 2 to ${WORKFLOW_PATHS.length} paths`)
      if (n.weights.some((w) => !Number.isFinite(w) || w < 0 || w > WORKFLOW_MAX_WEIGHT)) {
        return Result.fail(`A/B test ${id}'s weights must be 0 to ${WORKFLOW_MAX_WEIGHT}`)
      }
      if (!n.weights.some((w) => w > 0)) return Result.fail(`A/B test ${id} needs a path with a weight above 0`)
      return Result.succeed({ kind: "split", weights: n.weights, ...(n.each_run === true ? { each_run: true } : {}), ...where })
    case "send_to_task":
      if (bytes(n.message) > MAX_TEXT) return Result.fail(`send step ${id}'s message is longer than ${MAX_TEXT} bytes`)
      if (n.max_rounds < 0 || n.max_rounds > MAX_ROUNDS) return Result.fail(`send step ${id} can have at most ${MAX_ROUNDS} rounds`)
      return Result.succeed({ kind: "send_to_task", message: n.message, max_rounds: n.max_rounds, ...where })
    case "open_pr": {
      const title = n.title.trim()
      if (bytes(title) > 1000) return Result.fail(`pull request step ${id}'s title is longer than 1000 bytes`)
      if (bytes(n.body) > MAX_TEXT) return Result.fail(`pull request step ${id}'s body is longer than ${MAX_TEXT} bytes`)
      return Result.succeed({ kind: "open_pr", title, body: n.body, ...(n.draft === true ? { draft: true } : {}), ...where })
    }
    case "text":
      if (bytes(n.text) > MAX_TEXT) return Result.fail(`text ${id} is longer than ${MAX_TEXT} bytes`)
      return Result.succeed({ kind: "text", text: n.text, ...where })
    case "task":
      return Result.succeed({ kind: "task", ...where })
    case "project_prompt":
      return Result.succeed({ kind: "project_prompt", which: n.which, ...where })
    case "compose":
      if (bytes(n.template) > MAX_TEXT) return Result.fail(`compose ${id}'s template is longer than ${MAX_TEXT} bytes`)
      if (templateInputs(n.template).length > 20) return Result.fail(`compose ${id} has more than 20 inputs`)
      return Result.succeed({ kind: "compose", template: n.template, ...where })
    case "join":
      if (n.count < 1 || n.count > MAX_JOIN) return Result.fail(`join ${id} takes 1 to ${MAX_JOIN} inputs`)
      if (chars(n.separator) > 100) return Result.fail(`join ${id}'s separator is longer than 100 characters`)
      return Result.succeed({ kind: "join", separator: n.separator, count: n.count, ...where })
  }
  return Result.fail(`node ${id} is of no kind a workflow has`)
}

/**
 * The graph as given, checked against the project's agent configs (`configs`, their ids), and tidied. Fails with why
 * it's refused.
 */
export const checkGraph = (given: WorkflowGraph, configs: ReadonlyArray<string>): Result.Result<WorkflowGraph, string> => {
  if (given.nodes.length > MAX_NODES) return Result.fail(`a workflow has at most ${MAX_NODES} nodes`)
  const nodes: Array<WorkflowNode> = []
  const ids = new Set<string>()
  const columns = new Set<string>()
  let triggers = 0
  let agents = 0
  // Wires are read with the node ids as given (trimmed below for edges too).
  const edgesIn: ReadonlyArray<WorkflowEdge> = given.edges.map((e) => ({ ...e, from: e.from.trim(), to: e.to.trim() }))
  const first: WorkflowGraph = { nodes: given.nodes.map((n) => ({ ...n, id: n.id.trim() })), edges: edgesIn }
  for (const raw of first.nodes) {
    const checked = checkNode(raw, first, configs)
    if (Result.isFailure(checked)) return Result.fail(checked.failure)
    const n = checked.success
    if (ids.has(n.id)) return Result.fail(`two nodes have the id ${n.id}`)
    ids.add(n.id)
    if (n.kind === "trigger") triggers += 1
    if (n.kind === "agent") agents += 1
    if (n.kind === "column") {
      if (columns.has(n.status)) return Result.fail(`two nodes are the column ${statusLabel(n.status)}: a workflow has one node for each column`)
      columns.add(n.status)
    }
    nodes.push(n)
  }
  if (triggers > 1) return Result.fail("a workflow has one start for runs by hand at most")
  if (triggers === 0 && columns.size === 0) return Result.fail("a workflow needs a column node (or a start, to run it only by hand)")
  if (agents > MAX_AGENTS) return Result.fail(`a workflow has at most ${MAX_AGENTS} agent steps`)
  const g: WorkflowGraph = { nodes, edges: edgesIn }
  const seen = new Set<string>()
  // What can go into Done: Ready for merge's done and the steps after it.
  const merged = afterMerge(g)
  for (const e of g.edges) {
    const from = graphNode(g, e.from)
    if (from === undefined) return Result.fail(`an edge comes from node ${e.from}, which isn't in the graph`)
    const to = graphNode(g, e.to)
    if (to === undefined) return Result.fail(`an edge goes to node ${e.to}, which isn't in the graph`)
    if (e.input !== undefined) {
      // A data wire: from a value to an input, one wire to each.
      const outs = workflowDataOutputs(from)
      if (!outs.includes(e.port)) return Result.fail(`node ${e.from} gives no value ${e.port} (it gives ${outs.join(", ") || "none"})`)
      const ins = workflowDataInputs(to)
      if (!ins.includes(e.input)) return Result.fail(`node ${e.to} has no input ${e.input} (it has ${ins.join(", ") || "none"})`)
      const key = `${e.to}\u0000${e.input}`
      if (seen.has(key)) return Result.fail(`node ${e.to}'s input ${e.input} has two wires into it`)
      seen.add(key)
      continue
    }
    const out = isData(from) ? [] : ports(from)
    if (!out.includes(e.port)) return Result.fail(`node ${e.from} has no port ${e.port} (it has ${out.join(", ") || "none: it gives values"})`)
    if (to.kind === "trigger") return Result.fail("no edge can go into the start")
    if (isData(to)) return Result.fail(`node ${e.to} gives values, so no run goes into it: wire a value into one of its inputs instead`)
    if (to.kind === "column" && to.status === "done" && !merged.has(e.from)) {
      return Result.fail("only Ready for merge's done (and the steps after it) can go into Done: a task is done once it's merged")
    }
    const key = `${e.from}\u0000${e.port}\u0000${e.to}\u0000`
    if (seen.has(key)) return Result.fail(`the edge from ${e.from}.${e.port} to ${e.to} is there twice`)
    seen.add(key)
  }
  const loop = cycle(g)
  if (loop !== null) {
    return Result.fail(
      `the graph goes round in a loop through ${loop}: a run goes forward from where it starts (go round again through a column, or by sending to the task's agent)`,
    )
  }
  const d = dataCycle(g)
  if (d !== null) return Result.fail(`values go round in a loop through ${d}: a data node can't take its own value`)
  return Result.succeed(g)
}

/**
 * A data node whose value depends on itself through data wires, if any. A step's outputs come from its run (or an
 * earlier one), so a wire from a step back into one before it is no loop.
 */
export const dataCycle = (g: WorkflowGraph): string | null => {
  const data = new Set(g.nodes.filter(isData).map((n) => n.id))
  const wires = g.edges.filter((e) => e.input !== undefined && data.has(e.from) && data.has(e.to))
  const state = new Map<string, number>()
  const visit = (id: string): string | null => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return id
    state.set(id, 1)
    for (const e of wires) {
      if (e.from !== id) continue
      const c = visit(e.to)
      if (c !== null) return c
    }
    state.set(id, 2)
    return null
  }
  for (const id of [...data].toSorted()) {
    const c = visit(id)
    if (c !== null) return c
  }
  return null
}

/**
 * A node on a cycle, if the graph has one. A path into a column ends there (the next run starts from it), so a cycle
 * through a column is no loop.
 */
export const cycle = (g: WorkflowGraph): string | null => {
  const edges = flowEdges(g).filter((e) => graphNode(g, e.to)?.kind !== "column")
  const indegree = new Map<string, number>(g.nodes.map((n) => [n.id, 0]))
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n)
  let done = 0
  for (let n = ready.pop(); n !== undefined; n = ready.pop()) {
    done += 1
    for (const e of edges.filter((x) => x.from === n)) {
      const d = (indegree.get(e.to) ?? 0) - 1
      indegree.set(e.to, d)
      if (d === 0) ready.push(e.to)
    }
  }
  if (done >= g.nodes.length) return null
  const left = [...indegree]
    .filter(([, d]) => d > 0)
    .map(([n]) => n)
    .toSorted()
  return left[0] ?? ""
}
