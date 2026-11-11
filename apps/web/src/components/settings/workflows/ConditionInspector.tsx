import { WorkflowCheck, type WorkflowNode } from "@huntaway/contracts"
import { CheckFields } from "./CheckFields"
import type { NodePatch } from "./graph"

/** A Check step's settings. */
export function ConditionInspector({
  node: n,
  onChange,
}: {
  node: Extract<WorkflowNode, { readonly kind: "condition" }>
  onChange: (patch: NodePatch) => void
}) {
  return (
    <>
      <CheckFields label="Checks whether" checks={WorkflowCheck.literals} node={n} onChange={onChange} />
      {n.check === "changed" && (
        <p className="text-[11.5px] text-faint">
          Yes when the task's branch or its agent's last run differ from the workflow's last finished run on it, and always when it's run by hand.
        </p>
      )}
    </>
  )
}
