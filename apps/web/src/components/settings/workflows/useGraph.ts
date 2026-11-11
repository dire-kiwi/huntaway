import { isDataNode, WORKFLOW_PATHS, workflowDataInputs, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { useState, type RefObject } from "react"
import { freeSpot, nodeH, type View } from "./geometry"
import { afterMerge, dataLoop, freshId, patchNode, reaches, type NodePatch } from "./graph"
import type { NewNode } from "./newNodes"
import { nodeTitle } from "./text"

export type Selection = { node: string } | { edge: number } | null

/** The graph being edited and what's selected in it, with the changes the editor makes to it. */
export function useGraph({
  initialGraph,
  scroller,
  viewRef,
  setErr,
}: {
  initialGraph: WorkflowGraph
  scroller: RefObject<HTMLDivElement | null>
  viewRef: RefObject<View>
  setErr: (err: string | null) => void
}) {
  const [graph, setGraph] = useState<WorkflowGraph>(() => structuredClone(initialGraph))
  const [sel, setSel] = useState<Selection>(() => ({ node: initialGraph.nodes.find((n) => n.kind === "trigger" || n.kind === "column")?.id ?? "" }))

  const connect = (from: string, port: string, to: string) => {
    setErr(null)
    const target = graph.nodes.find((n) => n.id === to)
    if (!target || to === from) return
    if (target.kind === "trigger") return setErr("Nothing goes into the start: it's where a run begins.")
    if (isDataNode(target)) return setErr(`${nodeTitle(target)} gives values: wire a value into one of its inputs instead.`)
    if (target.kind === "column" && target.status === "done" && !afterMerge(graph).has(from))
      return setErr("Only Ready for merge's done, and the steps after it, go into Done: a task is done once it's merged.")
    if (graph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return
    if (reaches(graph, to, from))
      return setErr("That would make a loop. To go round again, go through a column, or send to the task's agent: its next turn starts the workflow again.")
    setGraph((g) => ({ nodes: g.nodes, edges: [...g.edges, { from, port, to }] }))
  }
  /** A data wire from `from`'s value `port` into `to`'s `input`, in place of the one there. */
  const connectData = (from: string, port: string, to: string, input: string) => {
    setErr(null)
    const source = graph.nodes.find((n) => n.id === from)
    if (from === to && source && isDataNode(source)) return
    if (dataLoop(graph, from, to)) return setErr("That would make the value depend on itself.")
    setGraph((g) => ({ nodes: g.nodes, edges: [...g.edges.filter((e) => !(e.to === to && e.input === input)), { from, port, to, input }] }))
  }
  const unwire = (to: string, input: string) => setGraph((g) => ({ nodes: g.nodes, edges: g.edges.filter((e) => !(e.to === to && e.input === input)) }))
  const addNode = (spec: Pick<NewNode, "base" | "make">) => {
    const id = freshId(graph, spec.base)
    const made: WorkflowNode = { ...spec.make(graph), id, x: 0, y: 0 }
    const el = scroller.current
    const v = viewRef.current
    const spot = freeSpot(graph, nodeH(made), {
      left: -v.x / v.k,
      top: -v.y / v.k,
      width: (el?.clientWidth ?? 800) / v.k,
      height: (el?.clientHeight ?? 460) / v.k,
    })
    const node: WorkflowNode = { ...made, ...spot }
    setGraph((g) => ({ nodes: [...g.nodes, node], edges: g.edges }))
    setSel({ node: id })
  }
  const removeNode = (id: string) => {
    setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) }))
    setSel(null)
  }
  const removeEdge = (i: number) => {
    setGraph((g) => ({ nodes: g.nodes, edges: g.edges.filter((_, k) => k !== i) }))
    setSel(null)
  }
  /** Whether a node can go: not the start a workflow can't do without (one with a column can). */
  const removable = (n: WorkflowNode, g = graph) => n.kind !== "trigger" || g.nodes.some((x) => x.kind === "column")
  const updateNode = (id: string, patch: NodePatch) =>
    setGraph((g) => {
      const nodes = g.nodes.map((n) => (n.id === id ? patchNode(n, patch) : n))
      // A wire into an input the node no longer has (a name gone from a template, say) goes with it.
      const changed = nodes.find((n) => n.id === id)
      const inputs = changed ? workflowDataInputs(changed) : []
      return { nodes, edges: g.edges.filter((e) => e.to !== id || e.input === undefined || inputs.includes(e.input)) }
    })
  /** Takes an A/B test's path `i` out, with its lines; the paths after it move up a letter, with theirs. */
  const removePath = (id: string, i: number) =>
    setGraph((g) => ({
      nodes: g.nodes.map((n) => (n.id === id && n.kind === "split" ? { ...n, weights: n.weights.filter((_, k) => k !== i) } : n)),
      edges: g.edges.flatMap((e) => {
        const k = e.from === id && e.input === undefined ? WORKFLOW_PATHS.indexOf(e.port) : -1
        if (k < 0 || k < i) return [e]
        const port = WORKFLOW_PATHS[k - 1]
        return k === i || port === undefined ? [] : [{ ...e, port }]
      }),
    }))
  const renameNode = (id: string, raw: string) => {
    const next = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
    if (!next || next === id || graph.nodes.some((n) => n.id === next)) return
    setGraph((g) => ({
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, id: next } : n)),
      edges: g.edges.map((e) => ({ ...e, from: e.from === id ? next : e.from, to: e.to === id ? next : e.to })),
    }))
    setSel({ node: next })
  }
  return { graph, setGraph, sel, setSel, connect, connectData, unwire, addNode, removeNode, removeEdge, removable, updateNode, removePath, renameNode }
}
