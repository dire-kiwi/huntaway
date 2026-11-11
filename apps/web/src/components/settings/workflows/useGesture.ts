import type { WorkflowEdge, WorkflowGraph } from "@huntaway/contracts"
import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from "react"
import { cutCrosses, edgePoints, insOf, type Pt, type View } from "./geometry"
import type { Selection } from "./useGraph"

export type Gesture =
  | { kind: "move"; id: string; dx: number; dy: number }
  | { kind: "link"; from: string; port: string; data: boolean; x: number; y: number }
  /** Dragging the canvas around (from where the pointer and the view were). */
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  /** A right-drag drawing a knife line: the wires it crosses are cut, as in Blender. */
  | { kind: "cut"; pts: Pt[] }
  | null

/** What the pointer is doing on the canvas: moving a node, drawing a line or a wire, panning, or cutting. */
export function useGesture({
  graph,
  setGraph,
  setSel,
  setView,
  setErr,
  at,
  edgeEnds,
  connect,
  connectData,
}: {
  graph: WorkflowGraph
  setGraph: Dispatch<SetStateAction<WorkflowGraph>>
  setSel: (sel: Selection) => void
  setView: Dispatch<SetStateAction<View>>
  setErr: (err: string | null) => void
  at: (e: { clientX: number; clientY: number }) => Pt
  edgeEnds: (e: WorkflowEdge) => { x1: number; y1: number; x2: number; y2: number } | null
  connect: (from: string, port: string, to: string) => void
  connectData: (from: string, port: string, to: string, input: string) => void
}) {
  const [gesture, setGesture] = useState<Gesture>(null)
  const onMove = useEffectEvent((e: PointerEvent) => {
    if (!gesture) return
    const p = at(e)
    if (gesture.kind === "move") {
      const x = Math.round((p.x - gesture.dx) / 10) * 10
      const y = Math.round((p.y - gesture.dy) / 10) * 10
      setGraph((g) => ({ nodes: g.nodes.map((n) => (n.id === gesture.id ? { ...n, x, y } : n)), edges: g.edges }))
    } else if (gesture.kind === "pan") {
      setView((v) => ({ ...v, x: gesture.ox + e.clientX - gesture.sx, y: gesture.oy + e.clientY - gesture.sy }))
    } else if (gesture.kind === "cut") {
      setGesture({ ...gesture, pts: [...gesture.pts, p] })
    } else setGesture({ ...gesture, x: p.x, y: p.y })
  })
  const onUp = useEffectEvent((e: PointerEvent) => {
    if (gesture?.kind === "cut" && gesture.pts.length > 1) {
      // The wires the knife line crosses go.
      const cut = gesture.pts
      const kept = graph.edges.filter((ed) => {
        const ends = edgeEnds(ed)
        return !ends || !cutCrosses(cut, edgePoints(ends.x1, ends.y1, ends.x2, ends.y2))
      })
      if (kept.length !== graph.edges.length) {
        setGraph((g) => ({ nodes: g.nodes, edges: kept }))
        setSel(null)
      }
    }
    if (gesture?.kind === "link") {
      const hit = document.elementFromPoint(e.clientX, e.clientY)
      if (gesture.data) {
        // A value goes into an input: the socket it's dropped on, or a node's only input.
        const socket = hit?.closest<HTMLElement>("[data-input]")?.dataset["input"]
        const nodeId = socket ? socket.slice(0, socket.lastIndexOf(".")) : hit?.closest<HTMLElement>("[data-node]")?.dataset["node"]
        const target = graph.nodes.find((n) => n.id === nodeId)
        const only = target && insOf(target).length === 1 ? insOf(target)[0] : undefined
        const input = socket ? socket.slice(socket.lastIndexOf(".") + 1) : only
        if (nodeId && input) connectData(gesture.from, gesture.port, nodeId, input)
        else if (nodeId) setErr("Drop the value on one of the step's inputs (the diamonds on its left).")
      } else {
        const to = hit?.closest<HTMLElement>("[data-node]")?.dataset["node"]
        if (to) connect(gesture.from, gesture.port, to)
      }
    }
    setGesture(null)
  })
  const active = gesture !== null
  useEffect(() => {
    if (!active) return undefined
    const move = (e: PointerEvent) => onMove(e)
    const up = (e: PointerEvent) => onUp(e)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [active])
  return [gesture, setGesture] as const
}
