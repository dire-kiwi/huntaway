import {
  isDataNode,
  workflowDataInputs,
  workflowDataOutputs,
  workflowPorts,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "@huntaway/contracts"
import type { LayoutGeometry } from "./workflowLayout"

export const NODE_W = 180
const HEAD = 46
export const PORT_H = 18
export const IN_Y = 15
/**
 * A node's outcomes on the canvas. A send's `sent` isn't one to connect: the run ends there (the agent's work goes on
 * from In progress), so the editor shows only its `out of rounds`, as the old one did.
 */
export const portsOf = (n: WorkflowNode): ReadonlyArray<string> => (n.kind === "send_to_task" ? ["exhausted"] : workflowPorts(n))
export const outsOf = (n: WorkflowNode): ReadonlyArray<string> => workflowDataOutputs(n)
export const insOf = (n: WorkflowNode): ReadonlyArray<string> => workflowDataInputs(n)
/** A node's rows: its outcomes and values on the right, then its inputs on the left (as Blender lays out a node). */
export const nodeH = (n: WorkflowNode): number => HEAD + (portsOf(n).length + outsOf(n).length + insOf(n).length) * PORT_H + 6
export const portY = (i: number): number => HEAD + i * PORT_H + PORT_H / 2
export const outY = (n: WorkflowNode, k: string): number => portY(portsOf(n).length + Math.max(0, outsOf(n).indexOf(k)))
export const inY = (n: WorkflowNode, k: string): number => portY(portsOf(n).length + outsOf(n).length + Math.max(0, insOf(n).indexOf(k)))
/** How Arrange sees the nodes as they're drawn: where an edge leaves its node (an outcome, or a value) and arrives (the top, or an input). */
export const LAYOUT: LayoutGeometry = {
  width: NODE_W,
  height: (n) => nodeH(n),
  fromY: (n, e) => (e.input !== undefined ? outY(n, e.port) : portY(Math.max(0, portsOf(n).indexOf(e.port)))),
  toY: (n, e) => (e.input !== undefined ? inY(n, e.input) : IN_Y),
  isData: (n) => isDataNode(n),
}

export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export type Pt = { x: number; y: number }

/** Points along `edgePath`'s curve, to tell whether a cut crosses it. */
export function edgePoints(x1: number, y1: number, x2: number, y2: number, n = 24): Pt[] {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  const [ax, bx, cx, ex] = [x1, x1 + dx, x2 - dx, x2]
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const [w0, w1, w2, w3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    pts.push({ x: w0 * ax + w1 * bx + w2 * cx + w3 * ex, y: (w0 + w1) * y1 + (w2 + w3) * y2 })
  }
  return pts
}

/** Whether segments ab and cd cross. */
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0
}

/** Whether a knife line drawn through `cut` crosses a curve through `curve`. */
export function cutCrosses(cut: ReadonlyArray<Pt>, curve: ReadonlyArray<Pt>): boolean {
  for (let i = 1; i < cut.length; i++)
    for (let j = 1; j < curve.length; j++) {
      const [a, b, c, d] = [cut[i - 1], cut[i], curve[j - 1], curve[j]]
      if (a && b && c && d && crosses(a, b, c, d)) return true
    }
  return false
}

/** Where the canvas is looking: its offset on screen, and its zoom. */
export type View = { x: number; y: number; k: number }
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2

/**
 * Where a new node of height `h` goes: the first place in view (`area`, in the graph's coordinates) clear of the others,
 * or else below them all.
 */
export function freeSpot(g: WorkflowGraph, h: number, area: { left: number; top: number; width: number; height: number }): Pt {
  const { left, top } = area
  const right = area.left + area.width - NODE_W - 20
  const bottom = area.top + area.height - h - 20
  const clear = (x: number, y: number) =>
    g.nodes.every((n) => x + NODE_W + 20 <= n.x || n.x + NODE_W + 20 <= x || y + h + 20 <= n.y || n.y + nodeH(n) + 20 <= y)
  for (let y = Math.ceil((top + 20) / 10) * 10; y <= bottom; y += 30)
    for (let x = Math.ceil((left + 20) / 10) * 10; x <= right; x += 40) if (clear(x, y)) return { x, y }
  return { x: 20, y: Math.max(0, ...g.nodes.map((n) => n.y + nodeH(n))) + 30 }
}

/** Where an outcome's socket is on the canvas. */
const portPos = (n: WorkflowNode, port: string): Pt => ({ x: n.x + NODE_W, y: n.y + portY(Math.max(0, portsOf(n).indexOf(port))) })
/** Where a value's socket is on the canvas. */
const outPos = (n: WorkflowNode, k: string): Pt => ({ x: n.x + NODE_W, y: n.y + outY(n, k) })

/** Where a graph's nodes are on the canvas, and where its ports and edges are from that. */
export function placement(graph: WorkflowGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const width = Math.max(1000, ...graph.nodes.map((n) => n.x + NODE_W + 80))
  const height = Math.max(420, ...graph.nodes.map((n) => n.y + nodeH(n) + 60))
  /** Where an edge's curve starts and ends. */
  function edgeEnds(e: WorkflowEdge): { x1: number; y1: number; x2: number; y2: number } | null {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) return null
    const p = e.input !== undefined ? outPos(a, e.port) : portPos(a, e.port)
    return { x1: p.x, y1: p.y, x2: b.x, y2: b.y + (e.input !== undefined ? inY(b, e.input) : IN_Y) }
  }
  return { byId, width, height, portPos, outPos, edgeEnds }
}

export type Places = ReturnType<typeof placement>
