import type { WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { Field, Input } from "../../ui"
import { TemplateField } from "../TemplateField"
import { TEMPLATES, Wired } from "./fields"
import type { NodePatch } from "./graph"

/** A Send to the task's agent step's settings: its message, and its rounds. */
export function SendInspector({
  node: n,
  graph,
  onChange,
  onUnwire,
}: {
  node: Extract<WorkflowNode, { readonly kind: "send_to_task" }>
  graph: WorkflowGraph
  onChange: (patch: NodePatch) => void
  onUnwire: (input: string) => void
}) {
  return (
    <>
      <Field
        label="Message"
        hint={
          <>
            Blank sends the serious issues the verdict steps found. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
          </>
        }
      >
        <Wired graph={graph} node={n} input="message" onUnwire={onUnwire}>
          <TemplateField graph={graph} self={n.id} rows={5} className="text-[12.5px]" value={n.message} onChange={(message) => onChange({ message })} />
        </Wired>
      </Field>
      <Field
        label="Rounds"
        hint="How many times in a row it sends before its out of rounds outcome runs (or, with nothing connected, the task moves to Needs attention)."
      >
        <div className="w-24">
          <Input
            type="number"
            min={1}
            max={20}
            value={n.max_rounds}
            onChange={(e) => onChange({ max_rounds: Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))) })}
          />
        </div>
      </Field>
    </>
  )
}
