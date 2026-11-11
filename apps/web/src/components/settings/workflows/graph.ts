import { isDataNode, WorkflowNode, type WorkflowEdge, type WorkflowGraph } from "@huntaway/contracts"
import { Option, Schema } from "effect"
import { statusLabel } from "./text"

/**
 * What the board adds to a column's prompt: how the agent says it's done, and what the board does then (the steps
 * after its done, up to the columns they move the task to), as the host words it (the workflow engine).
 */
export function doneNote(g: WorkflowGraph, id: string): string {
  const node = g.nodes.find((n) => n.id === id)
  if (!node || node.kind !== "column") return ""
  const list = afterDone(g, id)
  const finish = node.done_when === "finish"
  if (!list.length && !finish) return ""
  let p = finish
    ? "When the work you were asked for here is complete, call `finish_work`, then end your turn with a summary of what you did. A turn that ends without it leaves the task in Needs attention."
    : "When you're done, end your turn with a summary of what you did."
  if (list.length) p += ` The board then ${joined(list)}.`
  return p
}

const joined = (l: ReadonlyArray<string>) => (l.length === 1 ? (l[0] ?? "") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1] ?? ""}`)

/**
 * How the merging agent says it's merged, when the workflow's Ready for merge node `id` goes on to Done: the workflow
 * moves the task there (as the host's merge_finish words it). Empty otherwise: the agent sets it done itself.
 */
export function mergeNote(g: WorkflowGraph, id: string): string {
  const list = afterDone(g, id)
  if (!list.includes("moves the task to Done")) return ""
  return `Once it is merged, call \`finish_work\`, then end your turn with a summary of what you did: the board then ${joined(list)}. Don't set the task's status yourself. A turn that ends without \`finish_work\` leaves the task in Needs attention.`
}

/** What the board does once column node `id`'s work is done: the steps after its done, up to the columns they move the task to. */
function afterDone(g: WorkflowGraph, id: string): string[] {
  const then: string[] = []
  const seen = new Set([id])
  const flow = g.edges.filter((e) => e.input === undefined)
  let next = flow.filter((e) => e.from === id && e.port === "done").map((e) => e.to)
  while (next.length) {
    const later: string[] = []
    for (const to of next) {
      if (seen.has(to)) continue
      seen.add(to)
      const n = g.nodes.find((x) => x.id === to)
      if (!n) continue
      if (n.kind === "column") {
        then.push(`moves the task to ${statusLabel(n.status)}`)
        continue
      }
      if (n.kind === "open_pr") then.push("pushes your branch and opens its pull request (so don't open one yourself)")
      else if (n.kind === "agent") then.push(n.output === "verdict" ? `has "${n.name}" review your work` : `has "${n.name}" read your work`)
      else if (n.kind === "send_to_task") then.push("sends you what it found to fix")
      // What happens when it goes well: not after a failure, or a send out of rounds.
      later.push(...flow.filter((e) => e.from === to && e.port !== "failed" && e.port !== "exhausted").map((e) => e.to))
    }
    next = later
  }
  return then.filter((x, i) => then.indexOf(x) === i)
}

/** Ready for merge's node and the steps after its done that no other column or start reaches: what can go into Done (as the host's after_merge). */
export function afterMerge(g: WorkflowGraph): Set<string> {
  const merge = g.nodes.find((n) => n.kind === "column" && n.status === "ready_for_merge")
  if (!merge) return new Set()
  const flow = g.edges.filter((e) => e.input === undefined)
  const reach = (from: string, first: (e: WorkflowEdge) => boolean) => {
    const out = new Set<string>()
    let next = [from]
    while (next.length) {
      const later: string[] = []
      for (const id of next) {
        if (out.has(id)) continue
        out.add(id)
        for (const e of flow) if (e.from === id && (id !== from || first(e)) && g.nodes.find((n) => n.id === e.to)?.kind !== "column") later.push(e.to)
      }
      next = later
    }
    return out
  }
  // Not the steps a run from another column (or the start) reaches too: those would move an unmerged task to Done.
  const merged = reach(merge.id, (e) => e.port === "done")
  for (const n of g.nodes) {
    if (n.id === merge.id || (n.kind !== "column" && n.kind !== "trigger")) continue
    for (const id of reach(n.id, () => true)) if (id !== merge.id) merged.delete(id)
  }
  return merged
}

/**
 * Whether `to` reaches `from` already, so an edge from `from` to `to` would make a loop. A path into a column ends
 * there (the next run starts from it), so going round through a column is no loop.
 */
export function reaches(g: WorkflowGraph, to: string, from: string): boolean {
  const column = (id: string) => g.nodes.find((n) => n.id === id)?.kind === "column"
  if (column(to)) return false
  const seen = new Set<string>()
  const stack = [to]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === from) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of g.edges) if (e.input === undefined && e.from === id && !column(e.to)) stack.push(e.to)
  }
  return false
}

/** Whether a wire from data node `from` into data node `to` would make its value depend on itself. */
export function dataLoop(g: WorkflowGraph, from: string, to: string): boolean {
  const data = (id: string) => {
    const n = g.nodes.find((x) => x.id === id)
    return !!n && isDataNode(n)
  }
  if (!data(from) || !data(to)) return false
  const seen = new Set<string>()
  const stack = [to]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === from) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of g.edges) if (e.input !== undefined && e.from === id && data(e.to)) stack.push(e.to)
  }
  return false
}

/** A free id for a new node of a kind, e.g. `agent2`. */
export function freshId(g: WorkflowGraph, base: string): string {
  for (let i = 1; ; i++) {
    const id = `${base}${i}`
    if (!g.nodes.some((n) => n.id === id)) return id
  }
}

/** A change to a node's settings: a key given as undefined is taken off (unset fields are left out, never null). */
export type NodePatch = { readonly [key: string]: unknown }

const asNode = Schema.decodeUnknownOption(WorkflowNode)

/** Node `n` with `patch` made to it; as it was if that wouldn't be a node. */
export function patchNode(n: WorkflowNode, patch: NodePatch): WorkflowNode {
  const out: Record<string, unknown> = { ...n }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return Option.getOrElse(asNode(out), () => n)
}

/** A node's settings without its id and place, as a new node or a preset is made with. */
export type NodeBody = WorkflowNode extends infer N ? (N extends WorkflowNode ? Omit<N, "id" | "x" | "y"> : never) : never
