import { workflowWire, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { Unplug } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../../ui"
import { dataLabel, nodeTitle } from "./text"

export const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
export const TEMPLATES =
  "{{task.key}}, {{task.title}}, {{task.description}}, {{branch}}, {{commit}}, {{workflow}}, {{issues}}, and {{<step id>.text}} or {{<step id>.issues}}"

/** An input's own field, or, when a value is wired into it, where the value comes from and a way to unwire it. */
export function Wired({
  graph,
  node,
  input,
  onUnwire,
  children,
}: {
  graph: WorkflowGraph
  node: WorkflowNode
  input: string
  onUnwire: (input: string) => void
  children: ReactNode
}) {
  const w = workflowWire(graph, node.id, input)
  if (!w) return <>{children}</>
  const from = graph.nodes.find((x) => x.id === w.from)
  return (
    <div
      className="flex items-center gap-2 rounded border border-amber-400/40 bg-amber-400/5 px-2 py-1.5 text-[12px] text-muted"
      data-testid={`wired-${input}`}
    >
      <span className="h-2 w-2 shrink-0 rotate-45 bg-amber-400" />
      <span className="min-w-0 flex-1 truncate">
        From <b>{from ? nodeTitle(from) : w.from}</b> · {dataLabel(w.port)}
      </span>
      <Button size="sm" variant="ghost" title="Unwire it, to use its own text" onClick={() => onUnwire(input)}>
        <Unplug size={12} />
      </Button>
    </div>
  )
}
