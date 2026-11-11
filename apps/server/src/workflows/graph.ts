import { isDataNode, threadKindOf, workflowPorts, workflowWaits, workflowWire } from "@huntaway/contracts"
import type {
  Status,
  Task,
  ThreadKindFields,
  Timestamp,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRunSource,
  WorkflowRunState,
  WorkflowRunId,
  WorkflowId,
  TaskId,
} from "@huntaway/contracts"
import { workflowDone } from "../prompts/workflowDone.ts"
import { numbered } from "../prompts/workflowFixes.ts"

// What a workflow's graph says and how a run goes through it (docs/plan/06-server.md, Workflows; inventory 06, 2.1 and
// 2.2; huntaway's integrations/workflows/model.ts, engine/nodes.ts, engine/values.ts and prompt.ts render): pure
// functions over a graph and a run's state, with no clock, no database and no git. `WorkflowEngine` reads what they
// need, calls them, and writes what they return. A run's state here is a value: `plan` and `settle` return the next one.

// ---------- the model ----------

export type ColumnNode = Extract<WorkflowNode, { readonly kind: "column" }>
export type AgentNode = Extract<WorkflowNode, { readonly kind: "agent" }>

/** Most nodes a workflow can have, and agent steps among them. */
export const MAX_NODES = 80
export const MAX_AGENTS = 8
/** Most rounds a send (or an edge into In progress) can be given. */
export const MAX_ROUNDS = 20
export const MAX_TEXT = 20_000
/** How many finished runs a workflow keeps on each task. */
export const KEPT_RUNS = 20
/** The task type of a workflow's agent thread. */
export const WORKFLOW = "workflow"

/** A workflow's run as the engine keeps it: the wire's `WorkflowRun` with `task_run`, and without the workflow's name. */
export interface RunState {
  readonly id: WorkflowRunId
  readonly workflow_id: WorkflowId
  readonly task_id: TaskId
  readonly source: WorkflowRunSource
  readonly state: WorkflowRunState
  readonly head: string | null
  /** The task's latest agent run when it started (or when its waiting column's work was done), which tells whether its agent worked since. */
  readonly task_run: string | null
  readonly graph: WorkflowGraph
  readonly nodes: Readonly<Record<string, WorkflowNodeRun>>
  readonly rounds: Readonly<Record<string, number>>
  readonly detail: string | null
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
  readonly finished_at: Timestamp | null
}

export const isData = isDataNode
export const ports = workflowPorts
export const wire = workflowWire
/** Whether the task's agent works in column node `n`'s column, so that its `done` waits for that work. */
export const agentWorks = (n: WorkflowNode, g: WorkflowGraph): boolean => workflowWaits(n, g)

/** The graph's edges that a run goes along, without its data wires. */
export const flowEdges = (g: WorkflowGraph): ReadonlyArray<WorkflowEdge> => g.edges.filter((e) => e.input === undefined)

export const graphNode = (g: WorkflowGraph, id: string): WorkflowNode | undefined => g.nodes.find((n) => n.id === id)

export const triggerNode = (g: WorkflowGraph): WorkflowNode | undefined => g.nodes.find((n) => n.kind === "trigger")

/** The graph's node for column `status`: a graph has one for each column at most. */
export const columnNode = (g: WorkflowGraph, status: Status): ColumnNode | undefined =>
  g.nodes.find((n): n is ColumnNode => n.kind === "column" && n.status === status)

/** An A/B test's path's name, as the board shows it: `A` for port `a`. */
export const pathName = (port: string): string => port.toUpperCase()

const STATUS_LABELS: Readonly<Record<Status, string>> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  needs_attention: "Needs attention",
  in_review: "In review",
  ready_for_merge: "Ready for merge",
  done: "Done",
}

/** A column's name on the board. */
export const statusLabel = (status: Status): string => STATUS_LABELS[status]

/** How a node reads in events: an agent step's name, or its kind. */
export const nodeName = (n: WorkflowNode): string => {
  switch (n.kind) {
    case "agent":
      return n.name
    case "trigger":
      return "Trigger"
    case "condition":
      return "Condition"
    case "send_to_task":
      return "Send to the task's agent"
    case "open_pr":
      return "Open a pull request"
    case "split":
      return "A/B test"
    case "column":
      return statusLabel(n.status)
    case "text":
    case "task":
    case "project_prompt":
    case "compose":
    case "join":
    case "switch":
    default:
      return n.kind
  }
}

/**
 * What the board does once column node `id`'s work is done, as its prompt tells the agent: the steps after its `done`
 * up to the columns they move the task to, when they go well (both ways of a check, but not after a failure).
 */
export const afterDone = (g: WorkflowGraph, id: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  const seen = new Set<string>([id])
  const edges = flowEdges(g)
  let next = edges.filter((e) => e.from === id && e.port === "done").map((e) => e.to)
  while (next.length > 0) {
    const later: Array<string> = []
    for (const to of next) {
      if (seen.has(to)) continue
      seen.add(to)
      const n = graphNode(g, to)
      if (n === undefined) continue
      if (n.kind === "column") {
        out.push(`moves the task to ${statusLabel(n.status)}`)
        continue
      }
      if (n.kind === "open_pr") out.push("pushes your branch and opens its pull request (so don't open one yourself)")
      else if (n.kind === "agent") out.push(n.output === "verdict" ? `has "${n.name}" review your work` : `has "${n.name}" read your work`)
      else if (n.kind === "send_to_task") out.push("sends you what it found to fix")
      // What happens when it goes well: not after a failure, or a send out of rounds.
      later.push(...edges.filter((e) => e.from === to && e.port !== "failed" && e.port !== "exhausted").map((e) => e.to))
    }
    next = later
  }
  return out.filter((x, i) => out.indexOf(x) === i)
}

/**
 * The Ready for merge node and the steps after its done, up to the columns they move the task to, but none that a run
 * from another column or the start also reaches: what can move a task to Done, as it's merged by then.
 */
export const afterMerge = (g: WorkflowGraph): ReadonlySet<string> => {
  const merge = columnNode(g, "ready_for_merge")
  if (merge === undefined) return new Set()
  const edges = flowEdges(g)
  const reach = (from: string, first: (e: WorkflowEdge) => boolean): Set<string> => {
    const out = new Set<string>()
    let next = [from]
    while (next.length > 0) {
      const later: Array<string> = []
      for (const id of next) {
        if (out.has(id)) continue
        out.add(id)
        for (const e of edges) if (e.from === id && (id !== from || first(e)) && graphNode(g, e.to)?.kind !== "column") later.push(e.to)
      }
      next = later
    }
    return out
  }
  const merged = reach(merge.id, (e) => e.port === "done")
  for (const n of g.nodes) {
    if (n.id === merge.id || (n.kind !== "column" && n.kind !== "trigger")) continue
    for (const id of reach(n.id, () => true)) if (id !== merge.id) merged.delete(id)
  }
  return merged
}

/** Whether the board opens the pull request once column node `id`'s work is done (before it moves the task on). */
export const opensPr = (g: WorkflowGraph, id: string): boolean => {
  const seen = new Set<string>([id])
  const edges = flowEdges(g)
  const stack = edges.filter((e) => e.from === id && e.port === "done").map((e) => e.to)
  for (let to = stack.pop(); to !== undefined; to = stack.pop()) {
    if (seen.has(to)) continue
    seen.add(to)
    const n = graphNode(g, to)
    if (n === undefined || n.kind === "column") continue
    if (n.kind === "open_pr") return true
    stack.push(...edges.filter((e) => e.from === to).map((e) => e.to))
  }
  return false
}

/** The agent steps with a path to node `id`, in the graph's order: whose output it's given. */
export const upstream = (g: WorkflowGraph, id: string): ReadonlyArray<AgentNode> => {
  const seen = new Set<string>()
  const stack = [id]
  for (let to = stack.pop(); to !== undefined; to = stack.pop()) {
    for (const e of flowEdges(g)) {
      if (e.to !== to || seen.has(e.from)) continue
      seen.add(e.from)
      stack.push(e.from)
    }
  }
  return g.nodes.filter((n): n is AgentNode => n.kind === "agent" && n.id !== id && seen.has(n.id))
}

/**
 * What the agent is told once column node `n`'s work is done, after its prompt: how to say it's done, and what the board
 * does then (see `afterDone`).
 */
export const doneNote = (g: WorkflowGraph, n: ColumnNode): string => workflowDone(afterDone(g, n.id), n.done_when === "finish")

/** How the merging agent says it's merged, when a path from Ready for merge's done reaches Done; null otherwise. */
export const mergeFinishThen = (g: WorkflowGraph, n: ColumnNode): ReadonlyArray<string> | null => {
  const then = afterDone(g, n.id)
  return then.includes(`moves the task to ${statusLabel("done")}`) ? then : null
}

/** Whether a task gets In progress's prompt: as the project's start prompt, only its code tasks do (not scratch nor documents only). */
export const takesStartPrompt = (task: ThreadKindFields): boolean => threadKindOf(task)._tag === "Code"

/** Whether the agent was asked to say its work in column `node` is done with `finish_work`. */
export const asksFinish = (node: ColumnNode, takesStart: boolean): boolean => node.done_when === "finish" && (node.status !== "in_progress" || takesStart)

/** Why a task whose agent ended its turn without saying its work was done needs attention. */
export const unfinishedReason = (status: Status): string =>
  `The agent ended its turn without saying its work in ${statusLabel(status)} is done (with finish_work)`

// ---------- a run's state ----------

const PENDING: WorkflowNodeRun = { state: "pending" }

/** Node `id`'s part of the run (pending if it has none yet). */
export const runNode = (run: Pick<RunState, "nodes">, id: string): WorkflowNodeRun => run.nodes[id] ?? PENDING

export const settled = (r: WorkflowNodeRun): boolean => r.state !== "pending" && r.state !== "running"

/** The run with node `id`'s part replaced by what `f` makes of it. */
export const withNode = <R extends Pick<RunState, "nodes">>(run: R, id: string, f: (r: WorkflowNodeRun) => WorkflowNodeRun): R => ({
  ...run,
  nodes: { ...run.nodes, [id]: f(runNode(run, id)) },
})

/** `r` without the port it ended on. */
export const dropPort = ({ port: _port, ...rest }: WorkflowNodeRun): WorkflowNodeRun => rest
/** `r` without its text. */
export const dropText = ({ text: _text, ...rest }: WorkflowNodeRun): WorkflowNodeRun => rest

/** The node a run started at. */
export const startNode = (run: Pick<RunState, "nodes" | "graph">): WorkflowNode | undefined => {
  const id = Object.keys(run.nodes).find((k) => run.nodes[k]?.start === true)
  return id === undefined ? undefined : graphNode(run.graph, id)
}

/** The column node a run waits at for the task's agent's work there, which it was sent the prompt of. */
export const waitingColumn = (run: Pick<RunState, "nodes" | "graph">): ColumnNode | null => {
  for (const n of run.graph.nodes) {
    const r = run.nodes[n.id]
    if (n.kind === "column" && r?.start === true && r.state === "running") return n
  }
  return null
}

/**
 * Marks the nodes whose inputs have all settled as running (to run now) or skipped, until none are left to decide.
 * Returns the run and the nodes to run.
 */
export const plan = <R extends Pick<RunState, "nodes" | "graph">>(start: R, at: Timestamp): { readonly run: R; readonly ready: ReadonlyArray<string> } => {
  let run = start
  const edges = flowEdges(run.graph)
  for (;;) {
    const ready: Array<string> = []
    let changed = false
    for (const n of run.graph.nodes) {
      if (isData(n) || runNode(run, n.id).state !== "pending") continue
      const incoming = edges.filter((e) => e.to === n.id)
      // A column's `done` comes only where the run starts (waiting there until it does): others end their paths.
      const current = run
      const fromSettled = (from: string) =>
        graphNode(current.graph, from)?.kind === "column" ? runNode(current, from).state !== "running" : settled(runNode(current, from))
      if (!incoming.every((e) => fromSettled(e.from))) continue
      const taken = incoming.filter((e) => {
        const from = runNode(current, e.from)
        return from.state !== "skipped" && from.port === e.port
      }).length
      const go = taken > 0 && ((n.join ?? "any") === "any" || taken === incoming.length)
      run = withNode(run, n.id, (r) => (go ? { ...r, state: "running", started_at: at } : { ...r, state: "skipped" }))
      if (go) ready.push(n.id)
      changed = true
    }
    if (ready.length > 0 || !changed) return { run, ready }
  }
}

/**
 * The nodes a run can reach from where it starts: along its flow edges, up to the columns it moves the task to (whose
 * outcomes are the next run's).
 */
export const reachable = (run: Pick<RunState, "nodes" | "graph">): ReadonlySet<string> => {
  const from = startNode(run)
  const seen = new Set<string>()
  if (from === undefined) return seen
  const edges = flowEdges(run.graph)
  const stack = [from.id]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue
    seen.add(id)
    if (id !== from.id && graphNode(run.graph, id)?.kind === "column") continue
    for (const e of edges) if (e.from === id) stack.push(e.to)
  }
  return seen
}

/**
 * Ends the run once no node is left to run, or null while one is: its sends (and In progress) that it could have
 * reached but skipped give their rounds back. One past a column the run doesn't start at is the next run's.
 */
export const settle = <R extends RunState>(run: R, at: Timestamp): R | null => {
  if (run.state !== "running" || run.graph.nodes.some((n) => !isData(n) && !settled(runNode(run, n.id)))) return null
  const reach = reachable(run)
  const rounds = { ...run.rounds }
  for (const n of run.graph.nodes) {
    const counts = n.kind === "send_to_task" || (n.kind === "column" && n.status === "in_progress")
    if (counts && runNode(run, n.id).state === "skipped" && reach.has(n.id)) delete rounds[n.id]
  }
  return { ...run, rounds, state: "done", finished_at: at, updated_at: at }
}

/** Marks a run's nodes still to run as skipped and those running as stopped, saying `why`. Returns the run and the threads to stop. */
export const endNodes = <R extends Pick<RunState, "nodes" | "graph">>(
  start: R,
  why: string,
  at: Timestamp,
): { readonly run: R; readonly threads: ReadonlyArray<TaskId> } => {
  let run = start
  const threads: Array<TaskId> = []
  for (const n of start.graph.nodes) {
    if (isData(n)) continue
    const r = runNode(run, n.id)
    if (r.state === "pending") run = withNode(run, n.id, (x) => ({ ...x, state: "skipped" }))
    else if (r.state === "running") {
      run = withNode(run, n.id, (x) => ({ ...dropPort(x), state: "stopped", text: why, finished_at: at }))
      if (r.thread_id !== undefined) threads.push(r.thread_id)
    }
  }
  return { run, threads }
}

/** The nodes of a run that failed, as events list them: "<name>: <why>". */
export const failedSteps = (run: Pick<RunState, "nodes" | "graph">): ReadonlyArray<string> =>
  run.graph.nodes.filter((n) => runNode(run, n.id).state === "failed").map((n) => `${nodeName(n)}: ${runNode(run, n.id).text ?? ""}`)

const firstLine = (s: string) => s.split("\n")[0] ?? ""

/**
 * Why a run its task's agent finishing started (`finished`) leaves the task in Needs attention once it ended without
 * moving it: `why` if given, its being stopped, or the step that failed. Null: it goes to In review.
 */
export const releaseReason = (run: Pick<RunState, "nodes" | "graph" | "state" | "detail">, name: string, why: string | null): string | null => {
  if (why !== null) return `The workflow "${name}" ${why}`
  if (run.state === "stopped") return `The workflow "${name}" was stopped before it moved the task${run.detail !== null ? `: ${run.detail}` : ""}`
  const failed = run.graph.nodes.find((n) => runNode(run, n.id).state === "failed")
  return failed === undefined ? null : `The workflow "${name}" failed at ${nodeName(failed)}: ${firstLine(runNode(run, failed.id).text ?? "")}`
}

/** Why a run that was to move a merged task to Done left it in Ready for merge. */
export const mergeLeftReason = (run: Pick<RunState, "nodes" | "graph" | "state">, name: string, why: string | null): string => {
  if (why !== null) return `The workflow "${name}" ${why}`
  if (run.state === "stopped") return `The workflow "${name}" was stopped before it moved the merged task to Done`
  const failed = run.graph.nodes.find((n) => runNode(run, n.id).state === "failed")
  return failed !== undefined
    ? `The workflow "${name}" failed at ${nodeName(failed)} after the merge: ${firstLine(runNode(run, failed.id).text ?? "")}`
    : `The workflow "${name}" ended without moving the merged task to Done`
}

/** Why a task the workflow moved to Needs attention is there: the steps that failed, or else that the workflow did. */
export const movedReason = (run: Pick<RunState, "nodes" | "graph">, name: string): string => {
  const failed = failedSteps(run)
  return failed.length > 0 ? `The workflow "${name}" failed at ${firstLine(failed[0] ?? "")}` : `The workflow "${name}" moved it here`
}

/** The issues the run's verdict steps found, each with its step's name when there are several. */
export const runIssues = (run: Pick<RunState, "nodes" | "graph">): ReadonlyArray<string> => {
  const steps: Array<readonly [string, WorkflowNodeRun]> = []
  for (const n of run.graph.nodes) {
    if (n.kind !== "agent" || n.output !== "verdict") continue
    const r = run.nodes[n.id]
    if (r !== undefined && r.port === "issues") steps.push([n.name, r])
  }
  const several = steps.length > 1
  return steps.flatMap(([name, r]) => (r.issues ?? []).map((i) => (several ? `(${name}) ${i}` : i)))
}

/** Why a send with no rounds left gave up. */
export const exhaustedReason = (workflow: string, issues: number, used: number): string => {
  const sn = issues === 1 ? "" : "s"
  if (issues === 0) return `The workflow "${workflow}" is out of rounds`
  if (used === 0) return `The workflow "${workflow}" found ${issues} serious issue${sn}`
  if (used === 1) return `The workflow "${workflow}" found ${issues} serious issue${sn} after a round of fixes`
  return `The workflow "${workflow}" found ${issues} serious issue${sn} after ${used} rounds of fixes`
}

/** Why an edge into In progress with no rounds left leaves the task in Needs attention. */
export const outOfRoundsReason = (workflow: string, issues: number, used: number): string => {
  const times = used === 1 ? "once" : `${used} times`
  return issues === 0
    ? `The workflow "${workflow}" gave the agent its work ${times} in a row, as many as it can`
    : `The workflow "${workflow}" found ${issues} serious issue${issues === 1 ? "" : "s"} after ${used === 1 ? "a round" : `${used} rounds`} of fixes`
}

/**
 * An A/B test's path: the one the task kept (unless it picks again each run, or that path weighs nothing now), or else
 * one at random (`x` in [0, 1)), each as likely as its weight says. Null when no path weighs anything.
 */
export const pickPath = (
  node: Extract<WorkflowNode, { readonly kind: "split" }>,
  kept: string | null,
  x: number,
): { readonly port: string; readonly share: number; readonly kept: boolean } | null => {
  const paths = ports(node)
  const weight = (p: string) => node.weights[paths.indexOf(p)] ?? 0
  if (node.each_run !== true && kept !== null && weight(kept) > 0) return { port: kept, share: 0, kept: true }
  const total = paths.reduce((sum, p) => sum + weight(p), 0)
  if (!(total > 0)) return null
  let left = x * total
  let port = paths.findLast((p) => weight(p) > 0) ?? "a"
  for (const p of paths) {
    if (weight(p) <= 0) continue
    if (left < weight(p)) {
      port = p
      break
    }
    left -= weight(p)
  }
  return { port, share: Math.round((weight(port) / total) * 100), kept: false }
}

// ---------- values ----------

/** What a condition or switch checks without git: has the task a pull request, or a type or label. */
export const plainCheck = (task: Pick<Task, "pr_url" | "task_type" | "labels">, check: string, value: string | null): boolean => {
  if (check === "has_pr") return (task.pr_url?.trim() ?? "") !== ""
  if (check === "task_type") return (task.task_type ?? "code") === (value ?? "code")
  if (check === "label") return value !== null && task.labels.some((l) => l === value)
  return false
}

/** Where values are read from: the graph, its workflow's name, the task, the run, and what's read beside them. */
export interface ValueSource {
  readonly graph: WorkflowGraph
  readonly workflow: string
  readonly task: Pick<Task, "title" | "description" | "branch" | "pr_url" | "labels" | "task_type">
  readonly key: string
  /** None before a run (a start prompt, say). */
  readonly run: Pick<RunState, "id" | "nodes" | "graph" | "head"> | null
  /** The workflow's latest earlier runs on the task, newest first (at most 20), for a step's value from an earlier run. */
  readonly earlier: ReadonlyArray<Pick<RunState, "nodes">>
  /** The project's start, review and merge prompts (or the board's). */
  readonly projectPrompts: { readonly start: string; readonly review: string; readonly merge: string }
}

/**
 * `text` with its `{{…}}` filled in: `vars` (a compose node's wired inputs) first, then `task.key`, `task.title`,
 * `task.description`, `branch`, `commit`, `workflow`, `issues` (those the run found), and `<node id>.text`,
 * `<node id>.issues` and `<node id>.verdict` for its steps, and `<node id>.path` for its A/B tests. Unknown names stay.
 */
export const render = (text: string, src: Pick<ValueSource, "task" | "key" | "workflow" | "run">, vars: Readonly<Record<string, string>> = {}): string => {
  const { task, run } = src
  let out = ""
  let rest = text
  for (;;) {
    const i = rest.indexOf("{{")
    if (i < 0) break
    out += rest.slice(0, i)
    const after = rest.slice(i + 2)
    const j = after.indexOf("}}")
    if (j < 0) return out + rest.slice(i)
    const name = after.slice(0, j).trim()
    let value: string | null = Object.hasOwn(vars, name) ? (vars[name] ?? null) : null
    if (value === null) {
      switch (name) {
        case "task.key":
          value = src.key
          break
        case "task.title":
          value = task.title
          break
        case "task.description":
          value = task.description
          break
        case "branch":
          value = task.branch ?? ""
          break
        case "commit":
          value = run?.head ?? ""
          break
        case "workflow":
          value = src.workflow
          break
        case "issues":
          value = run !== null ? numbered(runIssues(run)) : ""
          break
        default: {
          const dot = name.indexOf(".")
          const id = name.slice(0, dot)
          const r = dot >= 0 ? run?.nodes[id] : undefined
          if (r !== undefined) {
            const field = name.slice(dot + 1)
            if (field === "text") value = r.text ?? ""
            else if (field === "issues") value = numbered(r.issues ?? [])
            else if (field === "verdict") value = r.verdict ?? ""
            else if (field === "path" && run !== null && graphNode(run.graph, id)?.kind === "split") value = r.port !== undefined ? r.port.toUpperCase() : ""
          }
        }
      }
    }
    out += value ?? rest.slice(i, i + 2 + j + 2)
    rest = after.slice(j + 2)
  }
  return out + rest
}

/** What step `id` did: in the run, or else in the workflow's latest earlier run on the task that it finished in. */
export const stepOutput = (src: Pick<ValueSource, "run" | "earlier">, id: string): WorkflowNodeRun | null => {
  const now = src.run?.nodes[id]
  if (now?.state === "done") return now
  for (const r of src.earlier) {
    const n = r.nodes[id]
    if (n?.state === "done") return n
  }
  return null
}

/** What node `node`'s input `input` reads: the value wired into it, or else its own text `own`, its templates filled in. */
export const inputValue = (src: ValueSource, node: Pick<WorkflowNode, "id">, input: string, own: string): string => {
  const e = wire(src.graph, node.id, input)
  return e === undefined ? render(own, src) : outputValue(src, e.from, e.port, 0)
}

/**
 * Node `id`'s value `port`, read now: a data node's from its inputs, and a step's from what it did in the run, or else
 * in the workflow's latest run on the task that ran it (so a prompt can take the issues of the last review).
 */
export const outputValue = (src: ValueSource, id: string, port: string, depth: number): string => {
  const n = graphNode(src.graph, id)
  if (n === undefined || depth > 40) return ""
  const input = (name: string): string => {
    const e = wire(src.graph, id, name)
    return e !== undefined ? outputValue(src, e.from, e.port, depth + 1) : ""
  }
  const { task } = src
  switch (n.kind) {
    case "agent": {
      const r = stepOutput(src, id)
      if (r === null) return ""
      return port === "issues" ? numbered(r.issues ?? []) : port === "verdict" ? (r.verdict ?? "") : (r.text ?? "")
    }
    case "open_pr":
      return stepOutput(src, id)?.text ?? task.pr_url ?? ""
    case "split":
      return stepOutput(src, id)?.text ?? ""
    case "column":
      return doneNote(src.graph, n)
    case "text":
      return render(n.text, src)
    case "task":
      switch (port) {
        case "title":
          return task.title
        case "description":
          return task.description
        case "key":
          return src.key
        case "branch":
          return task.branch ?? ""
        case "commit":
          return src.run?.head ?? ""
        case "pr":
          return task.pr_url ?? ""
        case "labels":
          return task.labels.join(", ")
        default:
          return ""
      }
    case "project_prompt":
      return src.projectPrompts[n.which]
    case "compose": {
      const vars: Record<string, string> = {}
      for (const name of templateNames(n.template)) if (wire(src.graph, id, name) !== undefined) vars[name] = input(name)
      return render(n.template, src, vars)
    }
    case "join":
      return joinInputs(n.count)
        .map((i) => input(i).trim())
        .filter((t) => t !== "")
        .join(n.separator.replaceAll("\\n", "\n"))
    case "switch":
      return input(plainCheck(task, n.check, n.value ?? null) ? "yes" : "no")
    case "trigger":
    case "condition":
    case "send_to_task":
    default:
      return ""
  }
}

const templateNames = (t: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const m of t.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) if (m[1] !== undefined && !out.includes(m[1])) out.push(m[1])
  return out
}

const joinInputs = (count: number) => Array.from({ length: Math.min(Math.max(count, 1), 8) }, (_, i) => `in${i + 1}`)

/**
 * Column node `n`'s prompt (wired, or its own with its templates filled in; `fallback` if that's empty), with what to
 * do when its work is done, unless its `next` is wired somewhere to say so.
 */
export const columnText = (src: ValueSource, n: ColumnNode, fallback: string): string => {
  const own = inputValue(src, n, "prompt", n.prompt).trim() || fallback
  const placed = src.graph.edges.some((e) => e.input !== undefined && e.from === n.id && e.port === "next")
  const note = placed ? "" : doneNote(src.graph, n)
  return note !== "" && own !== "" ? `${own}\n\n${note}` : note || own
}

/** `text`, ending with `note` unless it says so already. */
export const withNote = (text: string, note: string): string => (note !== "" && !text.includes(note) ? `${text}\n\n${note}` : text)

/** The latest of the runs (newest first) in which node `id` ran (not pending nor skipped). */
export const lastRan = <R extends Pick<RunState, "nodes">>(runs: ReadonlyArray<R>, id: string): R | null =>
  runs.find((r) => {
    const st = r.nodes[id]?.state
    return st !== undefined && st !== "pending" && st !== "skipped"
  }) ?? null

/** The path A/B test `id` took in the latest of the earlier runs (newest first) that reached it, if it was the same node then. */
export const keptPath = (runs: ReadonlyArray<Pick<RunState, "nodes" | "graph">>, id: string): string | null => {
  for (const r of runs) {
    const n = r.nodes[id]
    if (n?.state !== "done" || n.port === undefined) continue
    // The same node: an id given to another kind of node since starts again.
    return graphNode(r.graph, id)?.kind === "split" ? n.port : null
  }
  return null
}

/** Whether `changed` holds: true for a manual run; else unless the last finished run that reached it has the same head and agent run. */
export const changedSince = (run: Pick<RunState, "source" | "head" | "task_run">, last: Pick<RunState, "head" | "task_run"> | null): boolean =>
  run.source === "manual" || last === null || last.head !== run.head || last.task_run !== run.task_run
