import type { WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { Field, Toggle } from "../../ui"
import { TemplateField } from "../TemplateField"
import { TEMPLATES, Wired } from "./fields"
import type { NodePatch } from "./graph"

/** An Open a pull request step's settings: its title and body, and whether it's a draft. */
export function OpenPrInspector({
  node: n,
  graph,
  onChange,
  onUnwire,
}: {
  node: Extract<WorkflowNode, { readonly kind: "open_pr" }>
  graph: WorkflowGraph
  onChange: (patch: NodePatch) => void
  onUnwire: (input: string) => void
}) {
  return (
    <>
      <Field
        label="Title"
        hint={
          <>
            Blank is the task's key and title. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
          </>
        }
      >
        <Wired graph={graph} node={n} input="title" onUnwire={onUnwire}>
          <TemplateField
            graph={graph}
            self={n.id}
            className="h-7"
            value={n.title}
            placeholder="{{task.key}}: {{task.title}}"
            onChange={(title) => onChange({ title })}
          />
        </Wired>
      </Field>
      <Field
        label="Body"
        hint="Blank is the task's agent's last message (or else the task's description), written by the board, not an agent. An agent step before it can write one: {{<step id>.text}}, or wire its text in."
      >
        <Wired graph={graph} node={n} input="body" onUnwire={onUnwire}>
          <TemplateField graph={graph} self={n.id} rows={5} className="text-[12.5px]" value={n.body} onChange={(body) => onChange({ body })} />
        </Wired>
      </Field>
      <Toggle checked={!!n.draft} onChange={(v) => onChange({ draft: v || undefined })} label="Open it as a draft" />
      <p className="text-[11.5px] text-faint">
        The board pushes the task's branch and opens its pull request into the branch it started from, as the project's GitHub account. <i>Had one</i> when the
        task has a pull request already; <i>failed</i> when its branch has no commits of its own, or GitHub refused.
      </p>
    </>
  )
}
