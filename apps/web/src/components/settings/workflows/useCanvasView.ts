import type { WorkflowGraph } from "@huntaway/contracts"
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import { MAX_ZOOM, MIN_ZOOM, NODE_W, nodeH, type Pt, type View } from "./geometry"

/** Where the editor's canvas is looking: its pan and zoom, and what's under a pointer. */
export function useCanvasView(initialGraph: WorkflowGraph) {
  const inner = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // Nodes can be anywhere, left of and above the origin too: the view starts with the graph's top left corner in it.
  const [view, setView] = useState<View>(() => {
    const ns = initialGraph.nodes
    const out = (c: number[]) => (ns.length && Math.min(...c) < 0 ? 20 - Math.min(...c) : 0)
    return { x: out(ns.map((n) => n.x)), y: out(ns.map((n) => n.y)), k: 1 }
  })
  // The view as last drawn, for the pointer's and the new nodes' places between renders.
  const viewRef = useRef(view)
  useLayoutEffect(() => {
    viewRef.current = view
  }, [view])

  /** Where a pointer is, in the graph's coordinates (the canvas layer's box is moved and scaled by the view). */
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = inner.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const k = viewRef.current.k
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }
  /** Zooms to `k`, keeping the viewport's point (`cx`, `cy`), by default its middle, where it is. */
  const zoomTo = (k: number, cx?: number, cy?: number) =>
    setView((v) => {
      const el = scroller.current
      const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
      const [px, py] = [cx ?? (el?.clientWidth ?? 800) / 2, cy ?? (el?.clientHeight ?? 460) / 2]
      return { k: nk, x: px - ((px - v.x) * nk) / v.k, y: py - ((py - v.y) * nk) / v.k }
    })
  /** Fits the whole graph in view (Blender's View All). */
  const fit = (g: WorkflowGraph) => {
    const el = scroller.current
    if (!el || !g.nodes.length) return setView({ x: 0, y: 0, k: 1 })
    const minX = Math.min(...g.nodes.map((n) => n.x))
    const minY = Math.min(...g.nodes.map((n) => n.y))
    const maxX = Math.max(...g.nodes.map((n) => n.x + NODE_W))
    const maxY = Math.max(...g.nodes.map((n) => n.y + nodeH(n)))
    const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((el.clientWidth - 60) / (maxX - minX), (el.clientHeight - 60) / (maxY - minY))))
    return setView({ k, x: (el.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (el.clientHeight - (maxY - minY) * k) / 2 - minY * k })
  }
  // The wheel zooms around the pointer, as Blender's does (a listener of its own: React's wheel handlers are passive).
  const onWheel = useEffectEvent((e: WheelEvent) => {
    const el = scroller.current
    if (!el) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    zoomTo(viewRef.current.k * Math.exp(-step * 0.0015), e.clientX - r.left, e.clientY - r.top)
  })
  useEffect(() => {
    const el = scroller.current
    if (!el) return undefined
    const wheel = (e: WheelEvent) => onWheel(e)
    el.addEventListener("wheel", wheel, { passive: false })
    return () => el.removeEventListener("wheel", wheel)
  }, [])
  return { inner, scroller, view, setView, viewRef, at, zoomTo, fit }
}

export type CanvasView = ReturnType<typeof useCanvasView>
