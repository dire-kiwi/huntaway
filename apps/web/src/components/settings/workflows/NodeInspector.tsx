import { hostStatuses, type HostProject as Project } from "@huntaway/client"
import { isDataNode, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Flag, Trash2 } from "lucide-react"
import { useState } from "react"
import { useAvailableConfigs } from "../../boardHelpers"
import { Button, Field, Input } from "../../ui"
import { AgentInspector } from "./AgentInspector"
import { ColumnInspector } from "./ColumnInspector"
import { ConditionInspector } from "./ConditionInspector"
import { selectClass } from "./fields"
import type { NodePatch } from "./graph"
import { OpenPrInspector } from "./OpenPrInspector"
import { SendInspector } from "./SendInspector"
import { SplitInspector } from "./SplitInspector"
import { KIND_STYLE, nodeTitle } from "./text"
import { ValueInspector } from "./ValueInspector"

/** The selected node's settings. */
export function NodeInspector({
  project,
  node: n,
  inputs,
  graph,
  onUnwire,
  onChange,
  onRemovePath,
  onRename,
  onRemove,
}: {
  project: Project
  node: WorkflowNode
  inputs: number
  graph: WorkflowGraph
  onUnwire: (input: string) => void
  onChange: (patch: NodePatch) => void
  /** Takes an A/B test's path out, with its lines. */
  onRemovePath: (i: number) => void
  onRename: (id: string) => void
  /** None for the start a workflow can't do without. */
  onRemove?: (() => void) | undefined
}) {
  const configs = useAvailableConfigs(project.host_id, project.profile_id, project)
  const [id, setId] = useState(n.id)
  const statuses = hostStatuses()
  const style = KIND_STYLE[n.kind]
  return (
    <div className="space-y-3 text-[12.5px]">
      <div className={clsx("flex items-center gap-1.5 font-medium", style.tone)}>
        {style.icon}
        <span className="text-fg">{n.kind === "trigger" ? "Start" : nodeTitle(n)}</span>
        {onRemove && (
          <Button size="sm" variant="ghost" className="ml-auto" title="Remove this step" onClick={onRemove}>
            <Trash2 size={12} />
          </Button>
        )}
      </div>
      <Field label="Id" hint="How templates name its output, e.g. {{reviewer.text}}.">
        <Input
          className="h-7 font-mono text-[12px]"
          value={id}
          onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
          onBlur={() => (id ? onRename(id) : setId(n.id))}
        />
      </Field>
      {n.kind === "trigger" && (
        <p className="text-[11.5px] text-faint">
          Where a run you start from the task's details begins. Without a start, a workflow run by hand begins at its column for the task's column. Runs of
          their own begin at the columns.
        </p>
      )}
      {n.kind === "column" && <ColumnInspector project={project} node={n} graph={graph} statuses={statuses} onChange={onChange} onUnwire={onUnwire} />}
      {isDataNode(n) && <ValueInspector node={n} graph={graph} onChange={onChange} onUnwire={onUnwire} />}
      {n.kind === "condition" && <ConditionInspector node={n} onChange={onChange} />}
      {n.kind === "agent" && <AgentInspector project={project} configs={configs} node={n} graph={graph} onChange={onChange} onUnwire={onUnwire} />}
      {n.kind === "split" && <SplitInspector node={n} graph={graph} onChange={onChange} onRemovePath={onRemovePath} />}
      {n.kind === "send_to_task" && <SendInspector node={n} graph={graph} onChange={onChange} onUnwire={onUnwire} />}
      {n.kind === "open_pr" && <OpenPrInspector node={n} graph={graph} onChange={onChange} onUnwire={onUnwire} />}
      {n.kind !== "trigger" && inputs > 1 && (
        <Field label="Runs when">
          <select className={selectClass} value={n.join ?? "any"} onChange={(e) => onChange({ join: e.target.value === "all" ? "all" : undefined })}>
            <option value="any">Any of its inputs arrives</option>
            <option value="all">All of its inputs arrive</option>
          </select>
        </Field>
      )}
      {n.kind === "trigger" && !onRemove && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Flag size={11} /> A workflow needs a start or a column.
        </div>
      )}
    </div>
  )
}
