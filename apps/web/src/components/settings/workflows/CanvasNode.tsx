import { isDataNode, workflowWire, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { clsx } from "clsx"
import { IN_Y, NODE_W, PORT_H, inY, insOf, nodeH, outY, outsOf, portsOf, portY, type Pt } from "./geometry"
import { KIND_STYLE, PORT_LABELS, dataLabel, nodeText, nodeTitle, ownText, portLabel } from "./text"
import type { Gesture } from "./useGesture"
import type { Selection } from "./useGraph"

/** A node on the canvas: its title, its outcomes and values on the right, its inputs on the left. */
export function CanvasNode({
  node: n,
  graph,
  byId,
  selected,
  at,
  setSel,
  setGesture,
}: {
  node: WorkflowNode
  graph: WorkflowGraph
  byId: ReadonlyMap<string, WorkflowNode>
  selected: WorkflowNode | undefined
  at: (e: { clientX: number; clientY: number }) => Pt
  setSel: (sel: Selection) => void
  setGesture: (g: Gesture) => void
}) {
  const style = KIND_STYLE[n.kind]
  const on = selected?.id === n.id
  const linked = (p: string) => graph.edges.some((e) => e.from === n.id && e.port === p)
  const text = nodeText(n, graph)
  return (
    <div
      data-node={n.id}
      className={clsx(
        "absolute cursor-grab rounded-md border bg-panel shadow-sm active:cursor-grabbing",
        on ? "border-accent ring-2 ring-accent/20" : "border-line-strong",
      )}
      style={{ left: n.x, top: n.y, width: NODE_W, height: nodeH(n) }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        setSel({ node: n.id })
        const p = at(e)
        setGesture({ kind: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y })
      }}
    >
      {n.kind !== "trigger" && !isDataNode(n) && (
        <span className="absolute -left-1.5 h-3 w-3 rounded-full border border-line-strong bg-raised" style={{ top: IN_Y - 6 }} />
      )}
      <div className="space-y-0.5 px-2.5 pt-1.5">
        <div className={clsx("flex items-center gap-1.5 text-[12.5px] font-medium", style.tone)}>
          {style.icon}
          <span className="truncate text-fg">{nodeTitle(n)}</span>
          {n.join === "all" && <span className="ml-auto text-[10.5px] text-faint">all inputs</span>}
        </div>
        <div className="truncate text-[11px] text-faint" title={text}>
          {text}
        </div>
      </div>
      {portsOf(n).map((p, i) => (
        <div key={p} className="absolute right-0 flex items-center gap-1.5 text-[11px] text-muted" style={{ top: portY(i) - PORT_H / 2, height: PORT_H }}>
          <span>{portLabel(n, p)}</span>
          <span
            role="button"
            aria-label={`Connect ${nodeTitle(n)}: ${PORT_LABELS[p] ?? p}`}
            data-port={`${n.id}.${p}`}
            className={clsx(
              "-mr-1.5 h-3 w-3 cursor-crosshair rounded-full border",
              linked(p) ? "border-accent bg-accent" : "border-line-strong bg-raised hover:border-accent",
            )}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              const at0 = at(e)
              setGesture({ kind: "link", from: n.id, port: p, data: false, x: at0.x, y: at0.y })
            }}
          />
        </div>
      ))}
      {outsOf(n).map((k) => (
        <div
          key={`out-${k}`}
          className="absolute right-0 flex items-center gap-1.5 text-[11px] text-amber-200/80"
          style={{ top: outY(n, k) - PORT_H / 2, height: PORT_H }}
        >
          <span>{dataLabel(k)}</span>
          <span
            role="button"
            aria-label={`Wire ${nodeTitle(n)}: ${dataLabel(k)}`}
            data-output={`${n.id}.${k}`}
            className={clsx(
              "-mr-1.5 h-2.5 w-2.5 rotate-45 cursor-crosshair border",
              graph.edges.some((e) => e.input !== undefined && e.from === n.id && e.port === k)
                ? "border-amber-400 bg-amber-400"
                : "border-amber-400/70 bg-raised hover:bg-amber-400/60",
            )}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              const at0 = at(e)
              setGesture({ kind: "link", from: n.id, port: k, data: true, x: at0.x, y: at0.y })
            }}
          />
        </div>
      ))}
      {insOf(n).map((k) => {
        const w = workflowWire(graph, n.id, k)
        return (
          <div
            key={`in-${k}`}
            data-input={`${n.id}.${k}`}
            className="absolute left-0 flex w-full items-center gap-1.5 pr-2 text-[11px] text-amber-200/80"
            style={{ top: inY(n, k) - PORT_H / 2, height: PORT_H }}
          >
            <span className={clsx("-ml-1.5 h-2.5 w-2.5 shrink-0 rotate-45 border", w ? "border-amber-400 bg-amber-400" : "border-amber-400/70 bg-raised")} />
            <span className="shrink-0">{dataLabel(k)}</span>
            <span className="truncate text-faint">{w ? `← ${nodeTitle(byId.get(w.from) ?? n)} · ${dataLabel(w.port)}` : ownText(n, k)}</span>
          </div>
        )
      })}
    </div>
  )
}
