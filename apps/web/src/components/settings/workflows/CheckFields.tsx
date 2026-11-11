import { LABELS } from "@huntaway/client"
import { WorkflowCheck, type WorkflowNode } from "@huntaway/contracts"
import { Schema } from "effect"
import { Field } from "../../ui"
import { selectClass } from "./fields"
import type { NodePatch } from "./graph"
import { CHECK_LABELS } from "./text"

const isCheck = Schema.is(WorkflowCheck)
const FIRST_LABEL = LABELS[0] ?? "plan"

/** A check's fields, for a Check step and a Switch value: what it checks, and the type or label it looks for. */
export function CheckFields({
  label,
  checks,
  node: n,
  onChange,
}: {
  label: string
  /** The checks to choose from. */
  checks: ReadonlyArray<WorkflowCheck>
  node: Extract<WorkflowNode, { readonly kind: "condition" | "switch" }>
  onChange: (patch: NodePatch) => void
}) {
  return (
    <>
      <Field label={label}>
        <select
          className={selectClass}
          value={n.check}
          onChange={(e) => {
            const check = e.target.value
            if (isCheck(check)) onChange({ check, value: check === "task_type" ? "code" : check === "label" ? FIRST_LABEL : undefined })
          }}
        >
          {checks.map((c) => (
            <option key={c} value={c}>
              {CHECK_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>
      {n.check === "task_type" && (
        <Field label="Type">
          <select className={selectClass} value={n.value ?? "code"} onChange={(e) => onChange({ value: e.target.value })}>
            <option value="code">Code</option>
            <option value="scratch">Scratch</option>
          </select>
        </Field>
      )}
      {n.check === "label" && (
        <Field label="Label">
          <select className={selectClass} value={n.value ?? FIRST_LABEL} onChange={(e) => onChange({ value: e.target.value })}>
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  )
}
