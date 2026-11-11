import type { WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { clsx } from "clsx"
import type { Dispatch, SetStateAction } from "react"
import { Button } from "../../ui"
import { CanvasNode } from "./CanvasNode"
import { IN_Y, LAYOUT, edgePath, inY, type Places } from "./geometry"
import type { CanvasView } from "./useCanvasView"
import type { Gesture } from "./useGesture"
import type { Selection } from "./useGraph"
import { arrange } from "./workflowLayout"

/** The editor's canvas: the graph's lines and nodes, panned and zoomed by the view, with the zoom's controls. */
export function Canvas({
  graph,
  setGraph,
  places: { byId, width, height, portPos, outPos },
  canvas: { inner, scroller, view, at, zoomTo, fit },
  sel,
  setSel,
  selected,
  gesture,
  setGesture,
}: {
  graph: WorkflowGraph
  setGraph: Dispatch<SetStateAction<WorkflowGraph>>
  places: Places
  canvas: CanvasView
  sel: Selection
  setSel: (sel: Selection) => void
  selected: WorkflowNode | undefined
  gesture: Gesture
  setGesture: (g: Gesture) => void
}) {
  const linking = gesture?.kind === "link" ? gesture : null
  const linkFrom = linking ? byId.get(linking.from) : undefined
  const linkAt = linking && linkFrom ? (linking.data ? outPos(linkFrom, linking.port) : portPos(linkFrom, linking.port)) : null
  return (
    <div
      ref={scroller}
      data-testid="workflow-viewport"
      className={clsx(
        "relative h-[460px] min-w-0 flex-1 touch-none overflow-hidden rounded-md border border-line bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)]",
        gesture?.kind === "pan" ? "cursor-grabbing" : gesture?.kind === "cut" ? "cursor-crosshair" : "cursor-default",
      )}
      style={{ backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const background = e.target === e.currentTarget || e.target === inner.current || (e.target instanceof Element && e.target.tagName === "svg")
        if (e.button === 2) {
          // Right-drag cuts wires (Blender's knife, with Ctrl there), over nodes as well.
          e.preventDefault()
          setGesture({ kind: "cut", pts: [at(e)] })
        } else if (e.button === 1 || (e.button === 0 && background)) {
          e.preventDefault()
          if (e.button === 0) setSel(null)
          setGesture({ kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y })
        }
      }}
    >
      <div
        ref={inner}
        className="absolute top-0 left-0 select-none"
        style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
        data-testid="workflow-canvas"
      >
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height}>
          {graph.edges.map((e, i) => {
            const a = byId.get(e.from)
            const b = byId.get(e.to)
            if (!a || !b) return null
            const data = e.input !== undefined
            const p = data ? outPos(a, e.port) : portPos(a, e.port)
            const d = edgePath(p.x, p.y, b.x, b.y + (e.input !== undefined ? inY(b, e.input) : IN_Y))
            const on = sel && "edge" in sel && sel.edge === i
            return (
              <g
                key={`${e.from}-${e.port}-${e.to}-${e.input ?? ""}`}
                className="pointer-events-auto cursor-pointer"
                onPointerDown={(ev) => {
                  if (ev.button !== 0) return
                  ev.stopPropagation()
                  setSel({ edge: i })
                }}
              >
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  data-edge={data ? `${e.from}.${e.port}->${e.to}.${e.input ?? ""}` : `${e.from}.${e.port}->${e.to}`}
                />
                <path
                  d={d}
                  fill="none"
                  className={on ? "stroke-accent" : data ? "stroke-amber-400/70" : "stroke-line-strong"}
                  strokeWidth={on ? 2.5 : data ? 1.5 : 1.75}
                />
              </g>
            )
          })}
          {linking && linkAt && (
            <path
              d={edgePath(linkAt.x, linkAt.y, linking.x, linking.y)}
              fill="none"
              className={linking.data ? "stroke-amber-400" : "stroke-accent"}
              strokeWidth={1.75}
              strokeDasharray="4 3"
            />
          )}
          {gesture?.kind === "cut" && (
            <polyline
              points={gesture.pts.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              className="stroke-red-400"
              strokeWidth={1.5 / view.k}
              strokeDasharray={`${5 / view.k} ${4 / view.k}`}
              data-testid="workflow-cut"
            />
          )}
        </svg>
        {graph.nodes.map((n) => (
          <CanvasNode key={n.id} node={n} graph={graph} byId={byId} selected={selected} at={at} setSel={setSel} setGesture={setGesture} />
        ))}
      </div>
      <div
        className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 text-[11.5px] shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button size="sm" variant="ghost" title="Zoom out" onClick={() => zoomTo(view.k / 1.25)}>
          −
        </Button>
        <button
          type="button"
          className="w-11 text-center text-muted tabular-nums hover:text-fg"
          title="Back to 100%"
          data-testid="workflow-zoom"
          onClick={() => zoomTo(1)}
        >
          {Math.round(view.k * 100)}%
        </button>
        <Button size="sm" variant="ghost" title="Zoom in" onClick={() => zoomTo(view.k * 1.25)}>
          +
        </Button>
        <Button size="sm" variant="ghost" title="Fit the whole workflow in view" onClick={() => fit(graph)}>
          Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Lay the nodes out in columns along the way a run goes, so few wires cross"
          onClick={() => {
            const g = arrange(graph, LAYOUT)
            setGraph(g)
            fit(g)
          }}
        >
          Arrange
        </Button>
      </div>
    </div>
  )
}
