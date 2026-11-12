import type { HostProject as Project } from "@huntaway/client"
import type { Workflow, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { Trash2 } from "lucide-react"
import { useState } from "react"
import { Button, Field, Input, Modal, Toggle } from "../../ui"
import { Canvas } from "./Canvas"
import { placement } from "./geometry"
import { NEW_NODES, NEW_VALUES } from "./newNodes"
import { NodeInspector } from "./NodeInspector"
import { KIND_STYLE, dataLabel, nodeTitle, portLabel } from "./text"
import { useCanvasView } from "./useCanvasView"
import { useDeleteKey } from "./useDeleteKey"
import { useGesture } from "./useGesture"
import { useGraph } from "./useGraph"
import { useSave } from "./useSave"

/** Most nodes a workflow has. */
const MAX_NODES = 80

/** The workflow editor: its hooks (the view, the graph and selection, the pointer's gesture, saving) and its panes. */
export function WorkflowEditor({
  project,
  workflow,
  initialName,
  initialGraph,
  onSaved,
  onClose,
}: {
  project: Project
  workflow: Workflow | null
  initialName: string
  initialGraph: WorkflowGraph
  /** With whether the saved workflow is on. */
  onSaved: (enabled: boolean) => void
  onClose: () => void
}) {
  const [err, setErr] = useState<string | null>(null)
  const canvas = useCanvasView(initialGraph)
  const { graph, setGraph, sel, setSel, connect, connectData, unwire, addNode, removeNode, removeEdge, removable, updateNode, removePath, renameNode } =
    useGraph({ initialGraph, scroller: canvas.scroller, viewRef: canvas.viewRef, setErr })
  const places = placement(graph)
  const { byId } = places
  const [gesture, setGesture] = useGesture({
    graph,
    setGraph,
    setSel,
    setView: canvas.setView,
    setErr,
    at: canvas.at,
    edgeEnds: places.edgeEnds,
    connect,
    connectData,
  })
  useDeleteKey({ sel, graph, removable, removeEdge, removeNode })
  const { name, setName, enabled, setEnabled, busy, confirm, save, close } = useSave({
    project,
    workflow,
    initialName,
    initialGraph,
    graph,
    setErr,
    onSaved,
    onClose,
  })
  const selected = sel && "node" in sel ? byId.get(sel.node) : undefined
  const selectedEdge = sel && "edge" in sel ? graph.edges[sel.edge] : undefined

  return (
    <Modal title={workflow ? `Edit ${workflow.name}` : "New workflow"} onClose={close} onSubmit={() => save()} width="max-w-[1400px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-60 flex-1">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Review and summarise" autoFocus={!workflow} />
            </Field>
          </div>
          <div className="pb-1.5">
            <Toggle checked={enabled} onChange={setEnabled} label="On" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-faint">Add a step:</span>
          {NEW_NODES.map((s) => (
            <Button key={s.label} size="sm" variant="ghost" disabled={graph.nodes.length >= MAX_NODES} onClick={() => addNode(s)}>
              <span className={KIND_STYLE[s.kind].tone}>{KIND_STYLE[s.kind].icon}</span> {s.label}
            </Button>
          ))}
          <span className="ml-auto text-[11.5px] text-faint">
            Drag from a step's outcome to another step to connect them. Right-drag across lines to cut them; Delete or X removes what's selected. Drag the
            background to pan, scroll to zoom.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-faint">Add a value:</span>
          {NEW_VALUES.map((v) => (
            <Button key={v.label} size="sm" variant="ghost" disabled={graph.nodes.length >= MAX_NODES} onClick={() => addNode(v)}>
              <span className={KIND_STYLE[v.kind].tone}>{KIND_STYLE[v.kind].icon}</span> {v.label}
            </Button>
          ))}
          <span className="ml-auto text-[11.5px] text-faint">Drag from a value (◆ on the right) to an input (◆ on the left) to build a prompt.</span>
        </div>
        <div className="flex min-h-0 gap-3 narrow:flex-col">
          <Canvas
            graph={graph}
            setGraph={setGraph}
            places={places}
            canvas={canvas}
            sel={sel}
            setSel={setSel}
            selected={selected}
            gesture={gesture}
            setGesture={setGesture}
          />
          <div className="w-80 shrink-0 space-y-3 overflow-y-auto narrow:w-full md:max-h-[460px]" data-testid="workflow-inspector">
            {selected ? (
              <NodeInspector
                key={selected.id}
                project={project}
                node={selected}
                inputs={graph.edges.filter((e) => e.to === selected.id).length}
                graph={graph}
                onUnwire={(input) => unwire(selected.id, input)}
                onChange={(patch) => updateNode(selected.id, patch)}
                onRemovePath={(i) => {
                  removePath(selected.id, i)
                  setSel({ node: selected.id })
                }}
                onRename={(id) => renameNode(selected.id, id)}
                onRemove={removable(selected) ? () => removeNode(selected.id) : undefined}
              />
            ) : selectedEdge && sel && "edge" in sel ? (
              <EdgeInspector edge={selectedEdge} byId={byId} onRemove={() => removeEdge(sel.edge)} />
            ) : (
              <div className="space-y-2 text-[12px] text-faint">
                <p>Click a step to change it.</p>
                <p>
                  A step runs once a step before it ends on an outcome connected to it, or once all of them have (<i>all inputs</i>). One whose inputs can't
                  come is skipped.
                </p>
                <p>
                  A line into a <b>column</b> moves the task there, and the run goes on from that column once its work is done: what comes after a column is the
                  next run's. <b>Send to the task's agent</b> ends the run too: the agent's work then goes on from In progress. After its rounds, its{" "}
                  <i>out of rounds</i> outcome runs instead, or the task moves to Needs attention.
                </p>
              </div>
            )}
          </div>
        </div>
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => save()}>
            {workflow ? "Save" : "Create workflow"}
          </Button>
        </div>
      </div>
      {confirm.dialog}
    </Modal>
  )
}

const title = (n: WorkflowNode | undefined, id: string) => (n ? nodeTitle(n) : id)

/** A selected line or wire: what it joins, and a way to remove it. */
function EdgeInspector({ edge, byId, onRemove }: { edge: WorkflowEdge; byId: ReadonlyMap<string, WorkflowNode>; onRemove: () => void }) {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  return (
    <div className="space-y-2 text-[12.5px]">
      <div className="font-medium">{edge.input !== undefined ? "Wire" : "Connection"}</div>
      <div className="text-muted">
        {edge.input !== undefined ? (
          <>
            <b>{title(from, edge.from)}</b>'s <i>{dataLabel(edge.port)}</i> goes into <b>{title(to, edge.to)}</b>'s <i>{dataLabel(edge.input)}</i>.
          </>
        ) : (
          <>
            When <b>{title(from, edge.from)}</b> ends with <i>{portLabel(from, edge.port)}</i>, <b>{title(to, edge.to)}</b> runs.
          </>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        <Trash2 size={12} /> Remove
      </Button>
    </div>
  )
}
